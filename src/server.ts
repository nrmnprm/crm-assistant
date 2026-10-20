/** Demo server: static UI + JSON API, no framework. */
import './env.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ask, clearAnswerCache, type Turn } from './assistant.ts'
import { indexStats, loadIndex, rebuildIndex } from './kb.ts'
import { checkModels, llmStatus } from './llm.ts'
import { addGold, COMPANY, crm, gold, kbDocs, profiles, saveProfiles, userById, users } from './store.ts'
import { TOOL_NAMES } from './tools.ts'
import { logUsage, usageSummary } from './usage.ts'

const PORT = Number(process.env.PORT ?? 4320)
const HOST = process.env.HOST ?? '127.0.0.1'
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url))

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage, limit = 100_000): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object')
  return body as Record<string, unknown>
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

function historyOf(v: unknown): Turn[] {
  if (!Array.isArray(v)) return []
  return v.slice(-12).flatMap((t) => {
    if (!t || typeof t !== 'object') return []
    const o = t as Record<string, unknown>
    return (o.role === 'user' || o.role === 'assistant') && typeof o.text === 'string' && o.text.trim()
      ? [{ role: o.role as Turn['role'], text: o.text.slice(0, 3000) }]
      : []
  })
}

/** Live model calls cost money: a small per-client budget. The socket
 * address is used unless TRUST_PROXY=1 (then the proxy's own last hop). */
const hits = new Map<string, number[]>()
function rateLimit(req: IncomingMessage, perMinute: number) {
  if (llmStatus().mode !== 'live') return
  const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const ip = process.env.TRUST_PROXY === '1' && hops.length ? hops[hops.length - 1] : (req.socket.remoteAddress ?? '')
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= perMinute) throw new HttpError(429, 'too many requests, try again in a minute')
  recent.push(now)
  hits.set(ip, recent)
}
setInterval(() => {
  const now = Date.now()
  for (const [k, t] of hits) if (!t.some((x) => now - x < 60_000)) hits.delete(k)
}, 60_000).unref()

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  if (req.method === 'GET' && path === '/api/meta') {
    return send(res, 200, {
      company: COMPANY,
      today: crm.today,
      users: users.map((u) => ({ ...u, profile: profiles.find((p) => p.id === u.profileId)?.title })),
      llm: llmStatus(),
      index: indexStats(),
    })
  }
  if (req.method === 'POST' && path === '/api/chat') {
    rateLimit(req, 12)
    const b = await readJson(req)
    const q = str(b.question, 500).trim()
    if (!q) throw new HttpError(400, 'question is required')
    if (!userById(str(b.userId, 40))) throw new HttpError(400, 'unknown user')
    return send(res, 200, await ask(str(b.userId, 40), q, historyOf(b.history)))
  }
  if (req.method === 'POST' && path === '/api/feedback') {
    // "Good answer → save as a curated answer": it is indexed at once and
    // boosted in search, so the next person gets the reviewed wording.
    const b = await readJson(req)
    const user = userById(str(b.userId, 40))
    const question = str(b.question, 500).trim()
    const answer = str(b.answer, 4000).trim()
    if (!user || !question || !answer) throw new HttpError(400, 'userId, question and answer are required')
    addGold({ id: `g${Date.now().toString(36)}`, question, answer, createdBy: user.id, createdAt: crm.today })
    const stats = await rebuildIndex()
    return send(res, 200, { saved: true, index: stats })
  }
  if (req.method === 'GET' && path === '/api/kb') {
    return send(res, 200, { docs: kbDocs().map(({ body, ...d }) => ({ ...d, words: body.split(/\s+/).length })), gold, index: indexStats() })
  }
  if (req.method === 'POST' && path === '/api/reindex') {
    const stats = await rebuildIndex()
    logUsage({
      ts: new Date().toISOString(), userId: 'system', action: 'reindex', model: llmStatus().embedModel ?? '', llmCalls: 0,
      promptTokens: 0, completionTokens: 0, embedTokens: stats.embedTokens, costUsd: stats.costUsd, cached: false, replayed: false, durationMs: stats.ms,
    })
    return send(res, 200, stats)
  }
  if (req.method === 'POST' && path === '/api/cache/clear') return send(res, 200, { cleared: clearAnswerCache() })
  if (req.method === 'GET' && path === '/api/usage') return send(res, 200, usageSummary())
  if (req.method === 'GET' && path === '/api/profiles') return send(res, 200, { profiles, tools: TOOL_NAMES })
  const m = /^\/api\/profiles\/([\w-]+)$/.exec(path)
  if (req.method === 'PUT' && m) {
    const p = profiles.find((x) => x.id === m[1])
    if (!p) throw new HttpError(404, 'no such profile')
    const b = await readJson(req)
    if (typeof b.prompt === 'string' && b.prompt.trim()) p.prompt = b.prompt.slice(0, 4000)
    if (typeof b.model === 'string') p.model = b.model.trim() || null
    if (typeof b.temperature === 'number' && b.temperature >= 0 && b.temperature <= 1.5) p.temperature = b.temperature
    if (typeof b.maxTokens === 'number' && b.maxTokens >= 100 && b.maxTokens <= 4000) p.maxTokens = Math.round(b.maxTokens)
    if (Array.isArray(b.tools)) p.tools = b.tools.filter((t): t is string => typeof t === 'string' && TOOL_NAMES.includes(t))
    if (typeof b.seesFinance === 'boolean') p.seesFinance = b.seesFinance
    saveProfiles()
    return send(res, 200, p)
  }
  throw new HttpError(404, 'not found')
}

async function serveStatic(res: ServerResponse, path: string) {
  let decoded: string
  try {
    decoded = decodeURIComponent(path === '/' ? '/index.html' : path)
  } catch {
    throw new HttpError(400, 'bad path')
  }
  const file = join(PUBLIC, normalize(decoded).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(PUBLIC)) throw new HttpError(403, 'forbidden')
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    throw new HttpError(404, 'not found')
  }
}

const server = createServer(async (req, res) => {
  try {
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      throw new HttpError(400, 'bad URL')
    }
    if (path.startsWith('/api/')) await api(req, res, path)
    else await serveStatic(res, path)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : 'error' })
  }
})

loadIndex()
const checks = await checkModels()
const stats = await rebuildIndex()
server.listen(PORT, HOST, () => {
  const st = llmStatus()
  console.log(`CRM assistant demo: http://${HOST}:${PORT}`)
  for (const c of checks) console.log(`  ${c}`)
  console.log(`  index: ${indexStats().docs} docs, ${indexStats().chunks} chunks (${indexStats().withVectors} with vectors); ` +
    `rebuild: +${stats.added} ~${stats.changed} -${stats.removed} =${stats.unchanged}, embedded ${stats.embedded}`)
  console.log(st.mode === 'live' ? `  LLM: live (${st.model})` : `  LLM: replay/fallback only (${st.reason}); ${st.recordings} recordings`)
})
