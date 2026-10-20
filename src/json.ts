/** Parsing model output, ported from LensMap (daily_backend/src/lib/llm.ts).
 * Free models often wrap JSON in prose, code fences or <think> blocks, so the
 * parser takes the first balanced `{…}` instead of trusting the whole reply. */

const THINK_RE = /<think>[\s\S]*?<\/think>/g

export function extractJson(content: string): Record<string, unknown> | null {
  const cleaned = content.replace(THINK_RE, '').replace(/```(?:json)?/g, '')
  const start = cleaned.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1)) as Record<string, unknown>
      } catch {
        return null
      }
    }
  }
  return null
}

/** Reply text without reasoning blocks. */
export function stripThink(content: string): string {
  return content.replace(THINK_RE, '').trim()
}
