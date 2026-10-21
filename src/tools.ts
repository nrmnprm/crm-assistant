/** Tools the assistant can call. The rule they exist for: the model never
 * "remembers" a model code, a price, a stock level or an order status — it
 * asks a tool and retells the answer. Every tool returns compact JSON (tokens
 * cost money) and, when it finds nothing, says why and what to relax, so the
 * model does not spend another round guessing.
 *
 * Access is checked here, not in the prompt: a profile only gets the tools it
 * lists, a sales manager only sees their own customers, and credit limits are
 * hidden from profiles without finance access. */
import { catalog, crm, userById } from './store.ts'
import type { Availability, CatalogModel, Profile, ToolContext, User } from './types.ts'
import type { ToolDef } from './llm.ts'

const AVAIL_RANK: Record<Availability, number> = { in_stock: 0, in_transit: 1, on_order: 2 }

/** A date, not "in 9 days": models are bad at date arithmetic. */
function etaDate(days: number): string {
  const d = new Date(`${crm.today}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Pressure the fan delivers at the given airflow (linear interpolation on
 * the curve), or null when the airflow is beyond the curve. */
export function pressureAt(m: CatalogModel, airflow: number): number | null {
  const c = m.curve
  if (airflow < c[0][0] || airflow > c[c.length - 1][0]) return null
  for (let i = 1; i < c.length; i++) {
    const [q0, p0] = c[i - 1]
    const [q1, p1] = c[i]
    if (airflow <= q1) return p0 + ((p1 - p0) * (airflow - q0)) / (q1 - q0 || 1)
  }
  return null
}

function card(m: CatalogModel, extra: Record<string, unknown> = {}) {
  return {
    code: m.code,
    name: m.name,
    motor: m.motor,
    priceUsd: m.priceUsd,
    availability: m.availability,
    ...(m.availability === 'in_stock' ? { stockQty: m.stockQty } : { availableFrom: etaDate(m.etaDays) }),
    noiseDbA: m.noiseDbA,
    powerW: m.powerW,
    url: `/catalog/${m.code}`,
    ...extra,
  }
}

function categoryOf(text: string | undefined): string | null {
  if (!text) return null
  const t = text.toLowerCase()
  const cats = [...new Set(catalog.map((m) => m.category))]
  return (
    cats.find((c) => c.toLowerCase() === t) ??
    cats.find((c) => t.includes(c.toLowerCase().replace(/s$/, ''))) ??
    (/(axial|wall)/.test(t) ? 'Axial wall fans'
      : /(inline|circular|round)/.test(t) ? 'Inline duct fans'
        : /(rectangular|duct)/.test(t) ? 'Rectangular duct fans'
          : /(roof|kitchen)/.test(t) ? 'Roof fans' : null)
  )
}

// ---- catalogue tools ----

function catalogCategories() {
  const cats = [...new Set(catalog.map((m) => m.category))]
  return {
    categories: cats.map((c) => {
      const ms = catalog.filter((m) => m.category === c)
      return {
        category: c,
        models: ms.length,
        maxAirflowM3h: Math.max(...ms.map((m) => m.curve[m.curve.length - 1][0])),
        maxPressurePa: Math.max(...ms.map((m) => m.curve[0][1])),
        kitchenRated: ms.some((m) => m.maxAirTempC >= 120),
      }
    }),
  }
}

function categoryParams(args: { category?: string }) {
  const cat = categoryOf(args.category)
  if (!cat) return { error: `unknown category "${args.category ?? ''}"`, hint: 'call catalog_categories first' }
  const ms = catalog.filter((m) => m.category === cat)
  return {
    category: cat,
    params: [
      { name: 'airflow_m3h', unit: 'm³/h', range: [0, Math.max(...ms.map((m) => m.curve[m.curve.length - 1][0]))], required: true },
      { name: 'pressure_pa', unit: 'Pa', range: [0, Math.max(...ms.map((m) => m.curve[0][1]))], required: true },
      { name: 'max_noise_dba', unit: 'dB(A)', range: [Math.min(...ms.map((m) => m.noiseDbA)), Math.max(...ms.map((m) => m.noiseDbA))] },
      { name: 'motor', values: ['AC', 'EC'] },
      { name: 'budget_usd', range: [Math.min(...ms.map((m) => m.priceUsd)), Math.max(...ms.map((m) => m.priceUsd))] },
    ],
  }
}

interface SelectArgs {
  category?: string
  airflow_m3h?: number
  pressure_pa?: number
  tolerance_pct?: number
  max_noise_dba?: number
  motor?: 'AC' | 'EC'
  budget_usd?: number
  kitchen?: boolean
  ducted?: boolean
  limit?: number
}

/** Duty-point selection: the fan must deliver the required pressure at the
 * required airflow (within the tolerance). Results go stock first, then in
 * transit, then made to order; within each, the fit closest to a 15% margin
 * wins. The best fit that is not in stock is reported separately so the
 * model can mention it without pushing an unavailable unit first. */
export function selectFans(args: SelectArgs) {
  const q = Number(args.airflow_m3h)
  const p = Number(args.pressure_pa)
  if (!(q > 0) || !(p >= 0)) {
    return { error: 'airflow_m3h and pressure_pa are required', hint: 'ask the customer, or estimate airflow from room volume × air changes' }
  }
  const tol = Math.min(30, Math.max(0, Number(args.tolerance_pct ?? 10))) / 100
  const cat = categoryOf(args.category) ?? (args.kitchen ? 'Roof fans' : null)
  const limit = Math.min(8, Math.max(1, Number(args.limit ?? 4)))
  let pool = catalog.filter((m) => !cat || m.category === cat)
  if (args.kitchen) pool = pool.filter((m) => m.maxAirTempC >= 120)
  // Axial wall fans blow through a wall opening; they cannot work on a duct.
  if (args.ducted) pool = pool.filter((m) => m.category !== 'Axial wall fans')

  const reasons: string[] = []
  const fit = pool.flatMap((m) => {
    const at = pressureAt(m, q)
    if (at == null || at < p * (1 - tol)) return []
    return [{ m, at, margin: (at - p) / Math.max(p, 1) }]
  })
  if (!fit.length) {
    const maxQ = Math.max(...pool.map((m) => m.curve[m.curve.length - 1][0]))
    const best = pool
      .map((m) => ({ m, at: pressureAt(m, q) }))
      .filter((x) => x.at != null)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]
    reasons.push(q > maxQ ? `max airflow in ${cat ?? 'the catalogue'} is ${maxQ} m³/h` : `at ${q} m³/h the strongest model gives ${Math.round(best?.at ?? 0)} Pa (${best?.m.code})`)
  }
  let models = fit
  if (args.max_noise_dba) models = models.filter((x) => x.m.noiseDbA <= Number(args.max_noise_dba))
  if (fit.length && !models.length) reasons.push(`no fitting model is quieter than ${args.max_noise_dba} dB(A)`)
  if (args.motor) models = models.filter((x) => x.m.motor === args.motor)
  if (args.budget_usd) {
    const before = models.length
    models = models.filter((x) => x.m.priceUsd <= Number(args.budget_usd))
    if (before && !models.length) reasons.push(`the cheapest fitting model costs $${Math.min(...fit.map((x) => x.m.priceUsd))}`)
  }
  const byFit = (a: { margin: number }, b: { margin: number }) => Math.abs(a.margin - 0.15) - Math.abs(b.margin - 0.15)
  models.sort((a, b) => AVAIL_RANK[a.m.availability] - AVAIL_RANK[b.m.availability] || byFit(a, b) || a.m.priceUsd - b.m.priceUsd)
  const shown = models.slice(0, limit)
  const bestFit = [...models].sort(byFit)[0]
  const out = {
    duty: { airflow_m3h: q, pressure_pa: p, tolerance_pct: tol * 100, category: cat },
    total: models.length,
    inStockTotal: models.filter((x) => x.m.availability === 'in_stock').length,
    models: shown.map((x) => card(x.m, { pressureAtDutyPa: Math.round(x.at), marginPct: Math.round(x.margin * 100) })),
  }
  if (bestFit && !shown.includes(bestFit)) {
    Object.assign(out, { best_fit_not_shown: card(bestFit.m, { pressureAtDutyPa: Math.round(bestFit.at), marginPct: Math.round(bestFit.margin * 100) }) })
  }
  if (!models.length) Object.assign(out, { why_nothing: reasons.join('; ') || 'no model matches all filters', hint: 'relax the tolerance, noise, motor or budget' })
  return out
}

function getModel(args: { code?: string }) {
  const code = String(args.code ?? '').trim().toUpperCase()
  const m = catalog.find((x) => x.code === code)
  if (!m) {
    const near = catalog.filter((x) => x.code.startsWith(code.replace(/E$/, '').slice(0, 5))).slice(0, 5).map((x) => x.code)
    return { error: `no model ${code}`, ...(near.length ? { did_you_mean: near } : {}) }
  }
  return { ...card(m), category: m.category, voltage: m.voltage, maxAirTempC: m.maxAirTempC, curve_m3h_pa: m.curve }
}

function findAnalogs(args: { code?: string }) {
  const code = String(args.code ?? '').trim().toUpperCase()
  const m = catalog.find((x) => x.code === code)
  if (!m) return { error: `no model ${code}` }
  // An analog covers the original's best-efficiency point (half of max airflow).
  const q = m.curve[2][0]
  const p = m.curve[2][1]
  const analogs = catalog
    .filter((x) => x.code !== m.code && x.category === m.category)
    .flatMap((x) => {
      const at = pressureAt(x, q)
      return at != null && at >= p * 0.9 ? [{ x, at }] : []
    })
    .sort((a, b) => AVAIL_RANK[a.x.availability] - AVAIL_RANK[b.x.availability] || a.at - b.at)
    .slice(0, 4)
  return { original: card(m), duty: { airflow_m3h: q, pressure_pa: p }, analogs: analogs.map((a) => card(a.x, { pressureAtDutyPa: Math.round(a.at) })) }
}

// ---- access ----

/** Results that are an access refusal. Kept beside the result rather than in
 * it: the JSON the model reads stays exactly as recorded. */
const denials = new WeakSet<object>()

function deny<T extends object>(result: T): T {
  denials.add(result)
  return result
}

/** True when the tool refused because of the caller's role or ownership,
 * not because nothing matched. */
export function isDenied(result: object): boolean {
  return denials.has(result)
}

/** Which customers a profile may look up: sales managers only their own,
 * everyone else all of them. */
export type CustomerScope = 'own' | 'all'

export function customerScope(profile: Profile): CustomerScope {
  return profile.id === 'sales' ? 'own' : 'all'
}

/** Which orders a profile may look up by number. */
export function orderScope(profile: Profile): CustomerScope {
  return profile.id === 'sales' ? 'own' : 'all'
}

/** Tools that read customer records and are filtered by customerScope. */
export const CUSTOMER_TOOLS = ['find_customer', 'list_customers', 'customer_orders']

// ---- CRM tools ----

function visibleCustomers(ctx: ToolContext) {
  return customerScope(ctx.profile) === 'own' ? crm.customers.filter((c) => c.managerId === ctx.userId) : crm.customers
}

function customerCard(c: (typeof crm.customers)[number], ctx: ToolContext) {
  return {
    id: c.id,
    name: c.name,
    city: c.city,
    segment: c.segment,
    manager: userById(c.managerId)?.name ?? c.managerId,
    paymentTerms: c.paymentTerms,
    ...(ctx.profile.seesFinance
      ? { creditLimitUsd: c.creditLimitUsd, balanceUsd: c.balanceUsd, onCreditHold: c.onCreditHold }
      : { finance: 'hidden for this role' }),
  }
}

function findCustomer(args: { query?: string }, ctx: ToolContext) {
  const q = String(args.query ?? '').toLowerCase().trim()
  if (!q) return { error: 'query is required' }
  const match = (c: (typeof crm.customers)[number]) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase().split(' ')[0])
  const mine = visibleCustomers(ctx).filter(match)
  if (mine.length) return { customers: mine.slice(0, 5).map((c) => customerCard(c, ctx)) }
  const other = crm.customers.filter(match)
  if (other.length) return deny({ customers: [], note: `found ${other.length}, but not among your customers; ask their manager (${userById(other[0].managerId)?.name})` })
  return { customers: [], note: 'no customer with this name' }
}

function listCustomers(args: { on_credit_hold?: boolean; with_overdue_invoices?: boolean }, ctx: ToolContext) {
  if (!ctx.profile.seesFinance && (args.on_credit_hold || args.with_overdue_invoices)) return deny({ error: 'finance filters are not available for this role' })
  const overdue = (id: string) => crm.invoices.filter((i) => i.customerId === id && !i.paid && i.dueAt < crm.today)
  const list = visibleCustomers(ctx)
    .filter((c) => !args.on_credit_hold || c.onCreditHold)
    .filter((c) => !args.with_overdue_invoices || overdue(c.id).length > 0)
    .map((c) => ({
      ...customerCard(c, ctx),
      ...(ctx.profile.seesFinance
        ? { overdueInvoices: overdue(c.id).map((i) => ({ number: i.number, amountUsd: i.amountUsd, dueAt: i.dueAt })) }
        : {}),
    }))
  return { total: list.length, customers: list }
}

function customerOrders(args: { customer_id?: string; customer?: string }, ctx: ToolContext) {
  const vis = visibleCustomers(ctx)
  const name = String(args.customer ?? args.customer_id ?? '').toLowerCase().trim()
  const c =
    vis.find((x) => x.id === args.customer_id) ??
    vis.find((x) => name && (x.name.toLowerCase().includes(name) || name.includes(x.name.toLowerCase().split(' ')[0])))
  if (!c) {
    const out = { error: 'customer not found among yours', hint: 'call find_customer first' }
    const other = crm.customers.some((x) => x.id === args.customer_id || (name && (x.name.toLowerCase().includes(name) || name.includes(x.name.toLowerCase().split(' ')[0]))))
    return other ? deny(out) : out
  }
  const orders = crm.orders.filter((o) => o.customerId === c.id)
  const invoices = crm.invoices.filter((i) => i.customerId === c.id && !i.paid)
  return {
    customer: c.name,
    orders: orders.map((o) => ({ number: o.number, status: o.status, createdAt: o.createdAt, shipDate: o.shipDate, items: o.lines.length })),
    ...(ctx.profile.seesFinance
      ? { unpaidInvoices: invoices.map((i) => ({ number: i.number, amountUsd: i.amountUsd, dueAt: i.dueAt, overdue: i.dueAt < crm.today })) }
      : {}),
  }
}

function orderStatus(args: { order_number?: string }, ctx: ToolContext) {
  const n = String(args.order_number ?? '').trim().toUpperCase()
  const o = crm.orders.find((x) => x.number === n || x.number.endsWith(n))
  if (!o) return { error: `no order ${n}` }
  if (orderScope(ctx.profile) === 'own' && o.managerId !== ctx.userId) return deny({ error: `order ${o.number} belongs to another manager` })
  return {
    number: o.number,
    customer: crm.customers.find((c) => c.id === o.customerId)?.name,
    status: o.status,
    shipDate: o.shipDate,
    lines: o.lines.map((l) => {
      const m = catalog.find((x) => x.code === l.code)
      return {
        code: l.code,
        qty: l.qty,
        ...(ctx.profile.seesFinance ? { priceUsd: l.priceUsd } : {}),
        availability: m?.availability ?? 'unknown',
        ...(m && m.availability !== 'in_stock' ? { availableFrom: etaDate(m.etaDays) } : {}),
      }
    }),
  }
}

// ---- registry ----

type Runner = (args: Record<string, unknown>, ctx: ToolContext) => unknown

const TOOLS: Record<string, { def: ToolDef; run: Runner }> = {
  catalog_categories: {
    def: fn('catalog_categories', 'List of fan categories with airflow and pressure ranges. Call it first when you do not know which category fits.', {}),
    run: () => catalogCategories(),
  },
  category_params: {
    def: fn('category_params', 'Selection parameters and their units and ranges for a category, so you ask the customer in the right units.', {
      category: { type: 'string', description: 'Category name from catalog_categories' },
    }, ['category']),
    run: (a) => categoryParams(a as { category?: string }),
  },
  select_fans: {
    def: fn('select_fans', 'Select fans for a duty point (airflow and static pressure). Returns models sorted by availability, then by fit. Use it for every product recommendation.', {
      category: { type: 'string', description: 'Category name (optional)' },
      airflow_m3h: { type: 'number', description: 'Required airflow, m³/h' },
      pressure_pa: { type: 'number', description: 'Required static pressure at that airflow, Pa' },
      tolerance_pct: { type: 'number', description: 'Allowed pressure shortfall, % (default 10)' },
      max_noise_dba: { type: 'number', description: 'Noise limit, dB(A)' },
      motor: { type: 'string', enum: ['AC', 'EC'] },
      budget_usd: { type: 'number', description: 'Maximum price per unit, USD' },
      kitchen: { type: 'boolean', description: 'Kitchen exhaust: needs 120 °C rated fans' },
      ducted: { type: 'boolean', description: 'The fan works on a duct (supply or exhaust system). Excludes axial wall fans' },
      limit: { type: 'number', description: 'How many models to return (1-8, default 4)' },
    }, ['airflow_m3h', 'pressure_pa']),
    run: (a) => selectFans(a as SelectArgs),
  },
  get_model: {
    def: fn('get_model', 'Full data of one model by code: price, availability, noise, power, curve.', {
      code: { type: 'string', description: 'Model code, e.g. NW-ID-200E' },
    }, ['code']),
    run: (a) => getModel(a as { code?: string }),
  },
  find_analogs: {
    def: fn('find_analogs', 'Models of the same category that cover the duty point of a given model, available ones first.', {
      code: { type: 'string', description: 'Model code' },
    }, ['code']),
    run: (a) => findAnalogs(a as { code?: string }),
  },
  find_customer: {
    def: fn('find_customer', 'Find a customer by name. Returns the customer card (finance fields only for roles that may see them).', {
      query: { type: 'string', description: 'Part of the customer name' },
    }, ['query']),
    run: (a, ctx) => findCustomer(a as { query?: string }, ctx),
  },
  list_customers: {
    def: fn('list_customers', 'Customers visible to the user, optionally only those on credit hold or with overdue invoices (finance roles).', {
      on_credit_hold: { type: 'boolean' },
      with_overdue_invoices: { type: 'boolean' },
    }),
    run: (a, ctx) => listCustomers(a as { on_credit_hold?: boolean; with_overdue_invoices?: boolean }, ctx),
  },
  customer_orders: {
    def: fn('customer_orders', 'Orders of a customer and, for finance roles, unpaid invoices with overdue flags. Pass the id from find_customer or the customer name.', {
      customer_id: { type: 'string', description: 'Customer id from find_customer' },
      customer: { type: 'string', description: 'Customer name, if the id is unknown' },
    }),
    run: (a, ctx) => customerOrders(a as { customer_id?: string; customer?: string }, ctx),
  },
  order_status: {
    def: fn('order_status', 'Status, ship date and lines of an order by its number (SO-2026-0412 or 0412).', {
      order_number: { type: 'string', description: 'Order number' },
    }, ['order_number']),
    run: (a, ctx) => orderStatus(a as { order_number?: string }, ctx),
  },
}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }
}

export const TOOL_NAMES = Object.keys(TOOLS)

export function toolDefs(profile: Profile): ToolDef[] {
  return profile.tools.filter((t) => TOOLS[t]).map((t) => TOOLS[t].def)
}

/** Runs a tool. Always returns an object — the model needs an answer it can
 * read, not an exception. */
export function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Record<string, unknown> {
  if (!ctx.profile.tools.includes(name) || !TOOLS[name]) return deny({ error: `tool ${name} is not available for the ${ctx.profile.title} role` })
  try {
    return TOOLS[name].run(args, ctx) as Record<string, unknown>
  } catch (e) {
    return { error: `tool failed: ${(e as Error).message}` }
  }
}

// ---- access matrix ----

export interface AccessCell {
  /** none: tool not in the profile; yes: no row-level filter; own/all: customer or order scope. */
  level: 'none' | 'yes' | 'own' | 'all'
  label: string
  detail?: string
}

export interface AccessRow {
  key: string
  label: string
  cells: Record<string, AccessCell>
}

/** Tool × profile grid for the Profiles page, built from the stored profiles
 * and the same scope functions the tools use, so it cannot drift from what
 * the tools actually enforce. */
export function accessMatrix(profiles: Profile[], users: User[]): AccessRow[] {
  const nC = crm.customers.length
  const nO = crm.orders.length
  // "5/8" per employee of the profile: own customers (or orders) out of all.
  const ownCounts = (p: Profile, count: (u: User) => number, total: number) =>
    users.filter((u) => u.profileId === p.id).map((u) => `${u.name.split(' ')[0]} ${count(u)}/${total}`).join(', ') || `0/${total}`
  const rows: AccessRow[] = TOOL_NAMES.map((t) => ({
    key: t,
    label: t,
    cells: Object.fromEntries(profiles.map((p): [string, AccessCell] => {
      if (!p.tools.includes(t)) return [p.id, { level: 'none', label: '—' }]
      if (CUSTOMER_TOOLS.includes(t)) {
        return [p.id, customerScope(p) === 'own'
          ? { level: 'own', label: 'own', detail: `${ownCounts(p, (u) => crm.customers.filter((c) => c.managerId === u.id).length, nC)} customers` }
          : { level: 'all', label: 'all', detail: `${nC} customers` }]
      }
      if (t === 'order_status') {
        const prices = p.seesFinance ? '' : ', no prices'
        return [p.id, orderScope(p) === 'own'
          ? { level: 'own', label: 'own', detail: `${ownCounts(p, (u) => crm.orders.filter((o) => o.managerId === u.id).length, nO)} orders${prices}` }
          : { level: 'all', label: 'any order', detail: `${nO} orders${prices}` }]
      }
      return [p.id, { level: 'yes', label: '✓' }]
    })),
  }))
  rows.push({
    key: 'finance',
    label: 'finance fields',
    cells: Object.fromEntries(profiles.map((p): [string, AccessCell] => [p.id, p.seesFinance
      ? { level: 'yes', label: 'visible', detail: 'credit limit, balance, invoices, prices' }
      : { level: 'none', label: 'hidden' }])),
  })
  return rows
}

/** One-line summary of a tool result for the inspector. */
export function summarize(result: Record<string, unknown>): string {
  if (result.error) return `error: ${String(result.error).slice(0, 100)}`
  if (Array.isArray(result.models)) return `${result.total} fit, ${result.inStockTotal} in stock${result.why_nothing ? ` — ${result.why_nothing}` : ''}`
  if (Array.isArray(result.categories)) return `${result.categories.length} categories`
  if (Array.isArray(result.analogs)) return `${result.analogs.length} analogs`
  if (Array.isArray(result.customers)) return result.customers.length ? `${result.customers.length} customer(s)` : String(result.note ?? 'none')
  if (Array.isArray(result.orders)) return `${result.orders.length} orders`
  if (result.status) return `${result.number}: ${result.status}`
  if (result.code) return `model ${result.code}`
  return 'ok'
}
