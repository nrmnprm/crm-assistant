/** The assistant pipeline, one request:
 *
 *   briefing phrase? -> deterministic agenda + 1-2 sentences from the model
 *   answer cache     -> a shared answer to the same question costs nothing
 *   rewrite          -> only for follow-ups ("and how do I cancel it?") and
 *                       for non-English questions when search is lexical
 *   knowledge base   -> hybrid search, curated answers boosted
 *   model + tools    -> catalogue and CRM facts only through tools, at most
 *                       5 rounds, then a forced final answer
 *   checks           -> empty answer, product codes the tools never returned
 *   sources/actions  -> added by code, never by the model
 *
 * Every step lands in a trace with its timing, and every request in the
 * usage log with its tokens and cost. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { suggestActions } from './actions.ts'
import { briefing, isBriefingRequest, type BriefingBlock, type BriefingSource } from './briefing.ts'
import { search, type SearchResult } from './kb.ts'
import { LLM_MODEL, complete, type CompletionResult, type Message, type Usage } from './llm.ts'
import { catalog, crm, DATA, profileOf, userById } from './store.ts'
import { isDenied, runTool, summarize, toolDefs } from './tools.ts'
import { logUsage } from './usage.ts'
import type { Profile, User } from './types.ts'

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

export interface Step {
  name: string
  ms: number
  ok: boolean
  /** The tool refused because of the user's role or ownership. */
  denied?: boolean
  note: string
  detail?: unknown
}

export interface Answer {
  text: string
  kind: 'answer' | 'briefing'
  sources: { id: string; title: string; type: string; score: number }[]
  actions: { label: string; url: string }[]
  products: Record<string, unknown>[]
  blocks?: BriefingBlock[]
  /** Briefing only: whether the opening text came from the model or from code. */
  textSource?: BriefingSource
  /** Model codes in the answer that no tool returned in this request. */
  unverifiedCodes: string[]
  trace: {
    steps: Step[]
    model: string | null
    source: 'live' | 'replay' | 'cache' | 'fallback' | 'none'
    usage: { llmCalls: number; promptTokens: number; completionTokens: number; embedTokens: number; costUsd: number }
    durationMs: number
  }
}

const MAX_ROUNDS = 5
const HISTORY_TURNS = 6
const CACHE_TTL_MS = Number(process.env.ANSWER_CACHE_TTL_HOURS ?? 24) * 3600 * 1000
const CACHE_FILE = new URL('answer-cache.json', DATA)

// ---- answer cache ----

interface CachedAnswer {
  answer: Omit<Answer, 'trace'>
  costUsd: number
  createdAt: number
}

let answerCache: Record<string, CachedAnswer> = {}
try {
  if (existsSync(CACHE_FILE)) answerCache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
} catch {
  answerCache = {}
}

function cacheKey(question: string, profile: Profile, model: string): string {
  const norm = question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  // Changing the prompt or the model must not serve answers made with the old one.
  return createHash('md5').update(JSON.stringify([norm, profile.id, model, profile.prompt, profile.tools])).digest('hex')
}

export function clearAnswerCache(): number {
  const n = Object.keys(answerCache).length
  answerCache = {}
  if (process.env.DATA_WRITE !== '0') writeFileSync(CACHE_FILE, '{}')
  return n
}

// ---- helpers ----

class Tracker {
  steps: Step[] = []
  usage = { llmCalls: 0, promptTokens: 0, completionTokens: 0, embedTokens: 0, costUsd: 0 }
  source: Answer['trace']['source'] = 'none'
  model: string | null = null
  private t = Date.now()

  step(name: string, ok: boolean, note: string, detail?: unknown, denied = false) {
    const now = Date.now()
    this.steps.push({ name, ms: now - this.t, ok, ...(denied ? { denied } : {}), note, ...(detail !== undefined ? { detail } : {}) })
    this.t = now
  }

  llm(res: CompletionResult) {
    if (!res.ok) return
    this.usage.llmCalls++
    this.usage.promptTokens += res.usage?.promptTokens ?? 0
    this.usage.completionTokens += res.usage?.completionTokens ?? 0
    this.usage.costUsd += res.usage?.costUsd ?? 0
    this.model = res.model
    // One live call makes the whole answer live; replay only if all were replayed.
    if (res.source === 'live' || this.source === 'none') this.source = res.source
  }
}

function fmtUsd(n: number) {
  return `$${n.toFixed(n < 0.01 ? 5 : 3)}`
}

/** Heuristic gate before paying for a rewrite: short or anaphoric messages
 * lean on the previous turns ("and for the kitchen?", "how do I cancel it"). */
export function looksLikeFollowUp(q: string): boolean {
  const s = q.trim()
  if (s.length <= 40 || s.split(/\s+/).length <= 5) return true
  if (/^\s*(and|but|also|then|what about|а|и|но|тогда|ещё|еще|также)[\s,]/i.test(s)) return true
  return /(^|[\s,.;:!?])(it|its|this|that|these|those|they|them|there|его|её|ее|их|это|этот|эта|эти|там|туда)([\s,.;:!?]|$)/i.test(s)
}

function isEnglish(q: string): boolean {
  const latin = (q.match(/[a-z]/gi) ?? []).length
  const other = (q.match(/\p{L}/gu) ?? []).length - latin
  return latin >= other
}

const CODE_RE = /\bNW-[A-Z]{2}-\d+(?:-\d+)?E?\b/g

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/
/** A model writing the next turn itself: a role label on its own line. */
const ROLE_LEAK = /\n\s*["']?(user|assistant|system)["']?\s*:?\s*\n/i

function cleanText(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

/** What is wrong with an answer, or null when it can be shown. */
export function answerProblem(text: string, question: string): string | null {
  if (!text.trim()) return 'empty answer'
  if (CJK.test(text) && !CJK.test(question)) return 'text in another script'
  if (ROLE_LEAK.test(text)) return 'the model started writing the next turn'
  return null
}

function firstBreak(text: string, question: string): number {
  const cut = [CJK.test(question) ? -1 : text.search(CJK), text.search(ROLE_LEAK)].filter((i) => i >= 0)
  return cut.length ? Math.min(...cut) : text.length
}

// ---- the pipeline ----

export async function ask(userId: string, question: string, history: Turn[], opts: { searchOnly?: boolean } = {}): Promise<Answer> {
  const started = Date.now()
  const user = userById(userId) ?? userById('u-anna')!
  const profile = profileOf(user)
  const model = profile.model ?? LLM_MODEL
  const tr = new Tracker()
  const q = question.trim()

  // 1. Briefing: the list is computed, the model writes the intro only.
  if (isBriefingRequest(q)) {
    tr.step('route', true, 'briefing phrase → agenda from CRM data')
    const b = await briefing(user, profile, q, model)
    if (b.llm) tr.llm(b.llm)
    tr.step('briefing', true, `${b.blocks.reduce((s, x) => s + x.items.length, 0)} items in ${b.blocks.length} blocks; ${b.textSource === 'model' ? 'model wrote the intro' : b.llm ? 'model call failed, intro built by code' : 'no model call'}`)
    return finish(tr, user, q, started, { text: b.text, kind: 'briefing', textSource: b.textSource, blocks: b.blocks, sources: [], actions: [], products: [], unverifiedCodes: [] })
  }

  // 2. Shared answer cache: only for standalone questions.
  const key = cacheKey(q, profile, model)
  const hit = answerCache[key]
  if (!history.length && hit && Date.now() - hit.createdAt < CACHE_TTL_MS) {
    tr.source = 'cache'
    tr.model = model
    tr.step('cache', true, `hit — the same question was answered ${Math.round((Date.now() - hit.createdAt) / 60000)} min ago (it cost ${fmtUsd(hit.costUsd)} then)`)
    return finish(tr, user, q, started, hit.answer, true)
  }
  tr.step('cache', true, history.length ? 'skipped: a follow-up depends on the conversation' : 'miss')

  // 3. Rewrite into a standalone search query when needed.
  let searchQuery = q
  const needsContext = history.length > 0 && looksLikeFollowUp(q)
  const needsEnglish = !isEnglish(q)
  if (needsContext || needsEnglish) {
    const dialog = history.slice(-4).map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`).join('\n')
    const res = await complete({
      model,
      temperature: 0,
      maxTokens: 80,
      messages: [
        {
          role: 'system',
          content:
            'Rewrite the user\'s last message as one standalone search query in English for the company knowledge base. ' +
            'Resolve references to earlier messages. Use the company\'s terms: a complaint about a faulty unit ' +
            'is a warranty claim (RMA). Output only the query, without quotes.',
        },
        { role: 'user', content: `${dialog ? `Conversation:\n${dialog}\n\n` : ''}Last message: ${q}` },
      ],
    })
    tr.llm(res)
    const out = res.ok ? (res.message.content ?? '').trim().replace(/^["'«]|["'»]$/g, '') : ''
    if (out && out.length <= 300) searchQuery = out
    tr.step('rewrite', res.ok, res.ok ? `“${q}” → “${searchQuery}”` : `failed, searching the original (${res.error})`)
  } else {
    tr.step('rewrite', true, 'skipped: standalone English question')
  }

  // 4. Knowledge base.
  const found: SearchResult = await search(searchQuery)
  tr.usage.embedTokens += found.embedTokens
  tr.usage.costUsd += found.embedCostUsd
  tr.step(
    'search',
    true,
    `${found.mode}: ${found.hits.length} chunk(s) above the threshold, best ${found.candidates[0]?.score.toFixed(2) ?? '—'}`,
    found.candidates.map((h) => ({ title: h.chunk.title, score: +h.score.toFixed(3), lexical: +h.lexical.toFixed(3), cosine: h.cosine == null ? null : +h.cosine.toFixed(3), used: found.hits.includes(h) })),
  )
  const sources = dedupeSources(found)
  if (opts.searchOnly) return finish(tr, user, q, started, { text: '', kind: 'answer', sources, actions: [], products: [], unverifiedCodes: [] })

  // 5. Prompt.
  const tools = toolDefs(profile)
  const kb = found.hits.length
    ? `COMPANY KNOWLEDGE BASE (excerpts, most relevant first):\n\n${found.hits
        .map((h, i) => `=== [${i + 1}] ${h.chunk.title} (relevance ${h.score.toFixed(2)}) ===\n${h.chunk.text}`)
        .join('\n\n')}`
    : 'COMPANY KNOWLEDGE BASE: nothing relevant was found for this question.'
  const rules = tools.length
    ? '\n\nTOOLS: model codes, prices, stock, ETAs, customers and orders come ONLY from tool results. ' +
      'For a product recommendation call select_fans; if airflow or pressure is unknown, ask for it or estimate airflow from room volume × air changes and say so. ' +
      'Set ducted=true for any system with ducts, filters or grilles: axial wall fans only work through a wall opening. ' +
      'Offer in-stock models first; mention best_fit_not_shown as an on-order alternative. If a tool returns nothing, say what to relax instead of naming models from memory.'
    : '\n\nYou have no access to the catalogue or the CRM in this role; for prices, stock or orders, say who can help.'
  const system = `${profile.prompt}\n\nToday is ${crm.today}. You are talking to ${user.name} (${user.role}).${rules}\n\n${kb}`
  const messages: Message[] = [
    { role: 'system', content: system },
    ...history.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, content: t.text }) as Message),
    { role: 'user', content: q },
  ]
  tr.step('prompt', true, `${system.length.toLocaleString('en-US')} characters of system prompt, ${found.hits.length} KB excerpt(s), ${tools.length} tool(s)`, { system })

  // 6. Model, with tools.
  const toolResults: Record<string, unknown>[] = []
  let res = await complete({ model, messages, tools, temperature: profile.temperature, maxTokens: profile.maxTokens })
  tr.llm(res)
  if (!res.ok && res.error === 'empty completion') {
    // Small models sometimes produce neither text nor a valid tool call; one
    // deterministic retry usually fixes it.
    tr.step('model', false, 'empty completion — retrying once')
    res = await complete({ model, messages, tools, temperature: 0, maxTokens: profile.maxTokens })
    tr.llm(res)
    if (!res.ok && res.error === 'empty completion' && tools.length) {
      // Still nothing: a malformed tool call the provider could not parse.
      // Answer without tools; the code check below flags any model code that
      // did not come from a tool.
      tr.step('model', false, 'empty again — answering without tools')
      res = await complete({ model, messages, temperature: 0, maxTokens: profile.maxTokens })
      tr.llm(res)
    }
  }
  let rounds = 0
  while (res.ok && res.message.tool_calls?.length && rounds < MAX_ROUNDS) {
    rounds++
    messages.push(res.message)
    for (const call of res.message.tool_calls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        args = {}
      }
      const t0 = Date.now()
      const result = runTool(call.function.name, args, { userId: user.id, profile })
      toolResults.push(result)
      const denied = isDenied(result)
      tr.step(`tool ${call.function.name}`, !result.error && !denied, `${summarize(result)} (${Date.now() - t0} ms)`, { args, result }, denied)
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) })
    }
    res = await complete({ model, messages, tools, temperature: profile.temperature, maxTokens: profile.maxTokens })
    tr.llm(res)
  }
  if (res.ok && res.message.tool_calls?.length) {
    // Out of rounds and still calling tools: answer from what is known.
    messages.push({
      role: 'user',
      content: '[System message] The tool limit is reached. Do not call tools again; answer now from the data you already have, or say what needs to be clarified.',
    })
    res = await complete({ model, messages, tools, toolChoice: 'none', temperature: profile.temperature, maxTokens: profile.maxTokens })
    tr.llm(res)
    tr.step('tool limit', false, `${MAX_ROUNDS} rounds used — forced a final answer without tools`)
  }
  let text = res.ok ? cleanText(res.message.content ?? '') : ''
  const problem = res.ok && !res.message.tool_calls?.length ? answerProblem(text, q) : null
  if (problem) {
    // One retry with a stricter instruction; small models sometimes switch
    // alphabets or start writing the next turn of the conversation.
    tr.step('output guard', false, `${problem} — asking again`)
    const retry = await complete({
      model,
      temperature: 0,
      maxTokens: profile.maxTokens,
      messages: [...messages, { role: 'user', content: '[System message] Your previous answer was broken. Answer the last question again, only in the language of the question, plain text.' }],
    })
    tr.llm(retry)
    const again = retry.ok ? cleanText(retry.message.content ?? '') : ''
    if (retry.ok && again && !answerProblem(again, q)) {
      res = retry
      text = again
    } else {
      // Keep what is usable: the text up to the first broken spot.
      text = `${text.slice(0, firstBreak(text, q)).trim()} …`
      tr.step('output guard', false, 'the retry was broken too — the answer is cut at the first broken spot')
    }
  }
  if (!res.ok) {
    tr.source = 'fallback'
    tr.step('model', false, res.error)
    text = found.hits.length
      ? `The assistant is unavailable right now. The most relevant article is “${found.hits[0].chunk.title}”:\n\n${found.hits[0].chunk.text}`
      : 'The assistant is unavailable right now, and nothing relevant was found in the knowledge base.'
  } else {
    tr.step('model', true, `${tr.model}, ${tr.usage.llmCalls} call(s), ${rounds} tool round(s), ${tr.usage.promptTokens + tr.usage.completionTokens} tokens, ${fmtUsd(tr.usage.costUsd)}`)
    if (!text) {
      text = 'I could not put together an answer. Please rephrase the question or add details (category, airflow, pressure).'
      tr.step('empty answer', false, 'the model returned no text — a placeholder is shown')
    }
  }

  // 7. Checks: every product code in the text must come from a tool result.
  const fromTools = new Set(JSON.stringify(toolResults).match(CODE_RE) ?? [])
  const mentioned = [...new Set(text.match(CODE_RE) ?? [])]
  const unverifiedCodes = mentioned.filter((c) => !fromTools.has(c))
  if (mentioned.length) {
    const unknown = unverifiedCodes.filter((c) => !catalog.some((m) => m.code === c))
    tr.step(
      'check codes',
      !unverifiedCodes.length,
      unverifiedCodes.length
        ? `${unverifiedCodes.join(', ')} ${unknown.length ? '(not in the catalogue at all)' : '(exist, but no tool returned them in this request)'}`
        : `${mentioned.length} code(s), all from tool results`,
    )
  }
  const products = mentioned
    .filter((c) => fromTools.has(c))
    .flatMap((c) => {
      const m = catalog.find((x) => x.code === c)
      return m ? [{ code: m.code, name: m.name, priceUsd: m.priceUsd, availability: m.availability, stockQty: m.stockQty, etaDays: m.etaDays, noiseDbA: m.noiseDbA }] : []
    })
  const actions = suggestActions(`${q} ${searchQuery}`)
  const answer = { text, kind: 'answer' as const, sources: res.ok ? sources : [], actions, products, unverifiedCodes }

  // 8. Cache standalone answers that used no live data and name nobody.
  if (res.ok && !history.length && !toolResults.length && !text.includes(user.name.split(' ')[0])) {
    answerCache[key] = { answer, costUsd: tr.usage.costUsd, createdAt: Date.now() }
    if (process.env.DATA_WRITE !== '0') writeFileSync(CACHE_FILE, JSON.stringify(answerCache))
    tr.step('cache store', true, `saved for the next person with the ${profile.title} profile who asks the same`)
  }
  return finish(tr, user, q, started, answer)
}

/** Up to three documents, each close to the best one: a long tail of weak
 * matches tells the reader nothing. */
function dedupeSources(found: SearchResult) {
  const seen = new Set<string>()
  const out: Answer['sources'] = []
  const best = found.hits[0]?.score ?? 0
  for (const h of found.hits) {
    if (out.length >= 3 || h.score < best * 0.8) break
    if (seen.has(h.chunk.docId)) continue
    seen.add(h.chunk.docId)
    out.push({ id: h.chunk.docId, title: h.chunk.title, type: h.chunk.type, score: +h.score.toFixed(3) })
  }
  return out
}

function finish(tr: Tracker, user: User, q: string, started: number, a: Omit<Answer, 'trace'>, cached = false): Answer {
  const durationMs = Date.now() - started
  logUsage({
    ts: new Date().toISOString(),
    userId: user.id,
    action: a.kind === 'briefing' ? 'briefing' : 'chat',
    model: tr.model ?? '',
    llmCalls: cached ? 0 : tr.usage.llmCalls,
    promptTokens: cached ? 0 : tr.usage.promptTokens,
    completionTokens: cached ? 0 : tr.usage.completionTokens,
    embedTokens: tr.usage.embedTokens,
    costUsd: cached ? 0 : tr.usage.costUsd,
    cached,
    replayed: tr.source === 'replay',
    durationMs,
    question: q.slice(0, 200),
  })
  return { ...a, trace: { steps: tr.steps, model: tr.model, source: tr.source, usage: tr.usage, durationMs } }
}

export type { Usage }
