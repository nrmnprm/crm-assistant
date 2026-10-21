process.env.DATA_WRITE = '0'
process.env.LLM_CACHE_WRITE = '0'
process.env.EMBED_MODEL = ''

import { test } from 'node:test'
import assert from 'node:assert/strict'
const { chunkText, loadIndex, rebuildIndex, search, terms } = await import('../src/kb.ts')
const { accessMatrix, isDenied, pressureAt, runTool, selectFans } = await import('../src/tools.ts')
const { briefingBlocks, isBriefingRequest } = await import('../src/briefing.ts')
const { answerProblem, looksLikeFollowUp } = await import('../src/assistant.ts')
const { suggestActions } = await import('../src/actions.ts')
const { catalog, profiles, users } = await import('../src/store.ts')

const profile = (id: string) => profiles.find((p) => p.id === id)!
const user = (id: string) => users.find((u) => u.id === id)!

loadIndex()
await rebuildIndex()

test('chunks stay near 700 characters, overlap, and keep short tails attached', () => {
  const para = 'Sentence about fans and ducts. '.repeat(30)
  const chunks = chunkText(`${para}\n\n${para}\n\nShort tail.`)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((c) => c.length <= 900), chunks.map((c) => c.length).join(','))
  assert.ok(chunks.at(-1)!.includes('Short tail.'))
})

test('an unchanged knowledge base is not re-chunked on the next rebuild', async () => {
  const s = await rebuildIndex()
  assert.equal(s.added + s.changed + s.removed, 0)
  assert.ok(s.unchanged > 20)
})

test('lexical search finds the right article and boosts curated answers', async () => {
  const r = await search('who approves a 10% discount')
  assert.equal(r.mode, 'lexical')
  assert.match(r.hits[0].chunk.docId, /^qa:/)
  assert.ok(r.hits.some((h) => h.chunk.docId === 'kb:discount-approval'))
  const off = await search('what is the weather on mars')
  assert.equal(off.hits.length, 0)
  assert.deepEqual(terms('Fans approved'), ['fan', 'approv'])
})

test('pressure is interpolated on the fan curve', () => {
  const m = catalog.find((x) => x.code === 'NW-ID-200')!
  assert.equal(pressureAt(m, 0), m.curve[0][1])
  const mid = (m.curve[1][0] + m.curve[2][0]) / 2
  assert.equal(pressureAt(m, mid), (m.curve[1][1] + m.curve[2][1]) / 2)
  assert.equal(pressureAt(m, m.curve[4][0] + 1), null)
})

test('selection: ducted systems exclude wall fans, stock first, reasons when nothing fits', () => {
  const r = selectFans({ airflow_m3h: 1200, pressure_pa: 250, ducted: true }) as any
  assert.ok(r.models.length > 0)
  assert.ok(r.models.every((m: any) => !m.code.startsWith('NW-AX')))
  const ranks = r.models.map((m: any) => ['in_stock', 'in_transit', 'on_order'].indexOf(m.availability))
  assert.deepEqual(ranks, [...ranks].sort())
  assert.ok(r.models.every((m: any) => m.pressureAtDutyPa >= 250 * 0.9))
  const none = selectFans({ airflow_m3h: 50000, pressure_pa: 300 }) as any
  assert.equal(none.total, 0)
  assert.match(none.why_nothing, /max airflow/)
  assert.match((selectFans({}) as any).error, /required/)
})

test('access: managers see their own customers, finances only where allowed', () => {
  const anna = { userId: 'u-anna', profile: profile('sales') }
  const mark = { userId: 'u-mark', profile: profile('service') }
  const olga = { userId: 'u-olga', profile: profile('management') }
  const atlasForAnna = runTool('find_customer', { query: 'Atlas' }, anna) as any
  assert.equal(atlasForAnna.customers.length, 0)
  assert.match(atlasForAnna.note, /Olga Brandt/)
  assert.equal((runTool('find_customer', { query: 'Atlas' }, olga) as any).customers[0].balanceUsd, 11950)
  assert.match((runTool('find_customer', { query: 'Atlas' }, mark) as any).error, /not available/)
  const order = runTool('order_status', { order_number: '0412' }, mark) as any
  assert.equal(order.lines[0].priceUsd, undefined)
  assert.match((runTool('order_status', { order_number: '0419' }, anna) as any).error, /another manager/)
  const hold = runTool('list_customers', { on_credit_hold: true }, olga) as any
  assert.deepEqual(hold.customers.map((c: any) => c.name), ['Oakridge Hotels'])
  // Refusals are flagged for the inspector; "nothing found" is not a refusal.
  assert.ok(isDenied(atlasForAnna))
  assert.ok(isDenied(runTool('find_customer', { query: 'Atlas' }, mark)))
  assert.ok(isDenied(runTool('order_status', { order_number: '0419' }, anna)))
  assert.ok(isDenied(runTool('customer_orders', { customer: 'Atlas' }, anna)))
  assert.ok(!isDenied(runTool('find_customer', { query: 'Nobody Ltd' }, anna)))
  assert.ok(!isDenied(order))
})

test('the access matrix is generated from profiles and scope rules', () => {
  const rows = accessMatrix(profiles, users)
  const cell = (key: string, p: string) => rows.find((r) => r.key === key)!.cells[p]
  assert.equal(cell('find_customer', 'sales').level, 'own')
  assert.match(cell('find_customer', 'sales').detail!, /Anna 5\/8/)
  assert.equal(cell('find_customer', 'management').level, 'all')
  assert.equal(cell('find_customer', 'service').level, 'none')
  assert.equal(cell('order_status', 'service').label, 'any order')
  assert.match(cell('order_status', 'service').detail!, /no prices/)
  assert.equal(cell('finance', 'sales').label, 'visible')
  assert.equal(cell('finance', 'service').label, 'hidden')
})

test('the briefing is computed from CRM data per user', () => {
  assert.ok(isBriefingRequest("What's on my plate today?"))
  assert.ok(isBriefingRequest('что у меня сегодня'))
  assert.ok(!isBriefingRequest('How do I plan my day when a customer complains about noise in the meeting room?'))
  const anna = briefingBlocks(user('u-anna'), profile('sales'))
  assert.deepEqual(anna.map((b) => b.title), ['Tasks', 'Shipments', 'Overdue invoices'])
  assert.ok(anna.every((b) => b.source === 'db'))
  const mark = briefingBlocks(user('u-mark'), profile('service'))
  assert.deepEqual(mark.map((b) => b.title), ['Tasks'])
  assert.ok(mark[0].items.some((i) => i.tag === 'claim'))
})

test('guards and heuristics', () => {
  assert.ok(looksLikeFollowUp('and for the kitchen?'))
  assert.ok(looksLikeFollowUp('How do I cancel it if the customer changed their mind about the order?'))
  assert.ok(!looksLikeFollowUp('What is the warranty period for fans sold to hotel customers in the region?'))
  assert.equal(answerProblem('Откройте карточку铭俊', 'Как оформить рекламацию?'), 'text in another script')
  assert.equal(answerProblem('Steps:\n"user"\nHow do I', 'how?'), 'the model started writing the next turn')
  assert.equal(answerProblem('Fine answer.', 'q'), null)
  assert.deepEqual(suggestActions('Как оформить рекламацию?').map((a) => a.label), ['New warranty claim'])
  assert.equal(suggestActions('hello').length, 0)
})
