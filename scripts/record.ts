/** Answers the preset questions with the live model so a deployment without
 * a key can replay them. Clears the answer cache and the usage log first, so
 * every preset really reaches the model.
 *
 *   npm run record           # with OPENROUTER_API_KEY or a local LLM_BASE_URL
 *
 * Recordings land in data/llm-cache.json (keyed by the exact request). */
import '../src/env.ts'
import { rmSync } from 'node:fs'
import { ask, clearAnswerCache } from '../src/assistant.ts'
import { loadIndex, rebuildIndex } from '../src/kb.ts'
import { checkModels, llmStatus } from '../src/llm.ts'
import { DATA } from '../src/store.ts'

for (const line of await checkModels()) console.log(line)
if (llmStatus().mode !== 'live') {
  console.error(`Cannot record: ${llmStatus().reason}`)
  process.exit(1)
}
clearAnswerCache()
rmSync(new URL('usage.jsonl', DATA), { force: true })
loadIndex()
await rebuildIndex()

// Must match PRESETS in public/app.js.
const PRESETS: Record<string, string[]> = {
  'u-anna': [
    'Can we take back a fan that was made to order?',
    'Select a duct fan for 1,200 m³/h at 250 Pa, quieter than 50 dB(A).',
    'What is the status of order 0412?',
    'Does Atlas Construction have overdue invoices?',
    "What's on my plate today?",
    'Who approves a 10% discount?',
  ],
  'u-mark': [
    'How do I file a warranty claim?',
    'A customer says the fan is too weak after a year. What should I check?',
    'What is the status of order 0412?',
    "What's on my plate today?",
  ],
  'u-olga': [
    'Does Atlas Construction have overdue invoices?',
    'Which customers are on credit hold and why?',
    "What's on my plate today?",
    'Who approves a 15% discount?',
  ],
}

for (const [user, questions] of Object.entries(PRESETS)) {
  for (const q of questions) {
    // A fresh cache for every question: a cached answer would not record anything.
    clearAnswerCache()
    const a = await ask(user, q, [])
    const tools = a.trace.steps.filter((s) => s.name.startsWith('tool ')).map((s) => s.name.slice(5))
    console.log(`[${user}] ${q} -> ${a.trace.source}${tools.length ? `, tools: ${tools.join(', ')}` : ''}${a.unverifiedCodes.length ? `, UNVERIFIED ${a.unverifiedCodes}` : ''}`)
    console.log(`    ${a.text.replace(/\s+/g, ' ').slice(0, 220)}`)
    // A fallback means the provider refused (quota, 429): every further
    // question would fail the same way and free tiers count those refusals.
    if (a.trace.source === 'fallback') {
      console.error('stopped: the model did not answer; recordings so far are kept, run again later')
      process.exit(2)
    }
  }
}
clearAnswerCache()
rmSync(new URL('usage.jsonl', DATA), { force: true })
console.log('done: data/llm-cache.json')
