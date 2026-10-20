/** Cost accounting: one row per assistant request, with tokens and the cost
 * reported by the provider. Cached answers are logged too (cost 0), which is
 * what the "saved by cache" figure on the dashboard is computed from. Writing
 * a row never breaks an answer. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { DATA, userById } from './store.ts'

export interface UsageRow {
  ts: string
  userId: string
  action: 'chat' | 'briefing' | 'reindex'
  model: string
  llmCalls: number
  promptTokens: number
  completionTokens: number
  embedTokens: number
  costUsd: number
  cached: boolean
  /** Answers replayed from a recording cost nothing but are not cache hits. */
  replayed: boolean
  durationMs: number
  question?: string
}

const FILE = new URL('usage.jsonl', DATA)

export function logUsage(row: UsageRow) {
  if (process.env.DATA_WRITE === '0') return
  try {
    appendFileSync(FILE, JSON.stringify(row) + '\n')
  } catch {
    /* accounting must not break the answer */
  }
}

function rows(): UsageRow[] {
  if (!existsSync(FILE)) return []
  return readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as UsageRow]
      } catch {
        return []
      }
    })
}

export function usageSummary() {
  const all = rows()
  const live = all.filter((r) => r.action === 'chat' && !r.cached && !r.replayed && r.llmCalls > 0)
  const avgLive = live.length ? live.reduce((s, r) => s + r.costUsd, 0) / live.length : 0
  const hits = all.filter((r) => r.cached).length
  const answered = all.filter((r) => r.action === 'chat' && !r.cached && r.llmCalls > 0)
  const avgTokens = answered.length ? answered.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0) / answered.length : 0
  const group = (key: (r: UsageRow) => string) => {
    const m = new Map<string, { requests: number; tokens: number; costUsd: number; cached: number }>()
    for (const r of all) {
      const k = key(r)
      const g = m.get(k) ?? { requests: 0, tokens: 0, costUsd: 0, cached: 0 }
      g.requests++
      g.tokens += r.promptTokens + r.completionTokens
      g.costUsd += r.costUsd
      g.cached += r.cached ? 1 : 0
      m.set(k, g)
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.requests - a.requests)
  }
  return {
    totals: {
      requests: all.length,
      llmCalls: all.reduce((s, r) => s + r.llmCalls, 0),
      tokens: all.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0),
      embedTokens: all.reduce((s, r) => s + r.embedTokens, 0),
      costUsd: all.reduce((s, r) => s + r.costUsd, 0),
      cacheHits: hits,
      // What the cache hits would have cost: the average live answer × hits.
      savedUsd: avgLive * hits,
      savedTokens: Math.round(avgTokens * hits),
      avgLatencyMs: live.length ? Math.round(live.reduce((s, r) => s + r.durationMs, 0) / live.length) : 0,
    },
    byAction: group((r) => r.action),
    byUser: group((r) => userById(r.userId)?.name ?? r.userId),
    byDay: group((r) => r.ts.slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key)),
    recent: all.slice(-15).reverse(),
  }
}
