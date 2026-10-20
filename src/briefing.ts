/** "What is on my plate today?" The list is built by code from CRM data that
 * belongs to the asking user; the model only writes one or two sentences on
 * top. Nothing to report means no model call at all. Facts and money never
 * pass through the model. */
import { complete, type Usage } from './llm.ts'
import { crm } from './store.ts'
import type { Profile, User } from './types.ts'

export interface BriefingItem {
  text: string
  tag: 'overdue' | 'today' | 'soon' | 'money' | 'claim'
  link: string
}

export interface BriefingBlock {
  title: string
  items: BriefingItem[]
}

const BRIEFING_RE =
  /what('?s| is) on my (plate|list)|my (day|agenda)|brief(ing)? me|^\s*(briefing|agenda)\s*\??$|что у меня( на)? сегодня|мой день|сводк[ау] (на|за) (день|сегодня)|план на (день|сегодня)/i

/** Short phrases only: "what is on my plate" yes, a long question that
 * happens to contain "my day" no. */
export function isBriefingRequest(q: string): boolean {
  return q.trim().length <= 60 && BRIEFING_RE.test(q)
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
}

export function briefingBlocks(user: User, profile: Profile): BriefingBlock[] {
  const today = crm.today
  const all = profile.id === 'management'
  const mine = new Set(crm.customers.filter((c) => all || c.managerId === user.id).map((c) => c.id))
  const name = (id?: string) => crm.customers.find((c) => c.id === id)?.name ?? ''
  const blocks: BriefingBlock[] = []

  const tasks = crm.tasks.filter((t) => t.assigneeId === user.id && !t.done)
  const taskItems: BriefingItem[] = tasks
    .filter((t) => daysBetween(today, t.due) <= 1)
    .sort((a, b) => a.due.localeCompare(b.due))
    .map((t) => {
      const d = daysBetween(today, t.due)
      return {
        text: t.title + (d < 0 ? ` — ${-d} day${d === -1 ? '' : 's'} overdue` : d === 0 ? ' — today' : ' — tomorrow'),
        tag: t.kind === 'claim' ? 'claim' : d < 0 ? 'overdue' : d === 0 ? 'today' : 'soon',
        link: `/tasks/${t.id}`,
      }
    })
  if (taskItems.length) blocks.push({ title: 'Tasks', items: taskItems })

  if (profile.id !== 'service') {
    const ship = crm.orders
      .filter((o) => mine.has(o.customerId) && o.shipDate && ['confirmed', 'awaiting_stock'].includes(o.status))
      .filter((o) => daysBetween(today, o.shipDate!) >= 0 && daysBetween(today, o.shipDate!) <= 1)
      .map<BriefingItem>((o) => ({
        text: `${o.number} for ${name(o.customerId)} ships ${o.shipDate === today ? 'today' : 'tomorrow'}`,
        tag: o.shipDate === today ? 'today' : 'soon',
        link: `/orders/${o.number}`,
      }))
    if (ship.length) blocks.push({ title: 'Shipments', items: ship })

    if (profile.seesFinance) {
      const overdue = crm.invoices
        .filter((i) => mine.has(i.customerId) && !i.paid && i.dueAt < today)
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
        .map<BriefingItem>((i) => ({
          text: `${i.number}, ${name(i.customerId)}: $${i.amountUsd.toLocaleString('en-US')} — ${daysBetween(i.dueAt, today)} days overdue`,
          tag: 'money',
          link: `/finance/invoices/${i.number}`,
        }))
      if (overdue.length) blocks.push({ title: 'Overdue invoices', items: overdue })
    }
  }
  return blocks
}

export async function briefing(user: User, profile: Profile, question: string, model: string) {
  const blocks = briefingBlocks(user, profile)
  const count = blocks.reduce((s, b) => s + b.items.length, 0)
  if (!count) return { text: 'Nothing urgent today: no tasks due, no shipments, no overdue invoices.', blocks, usage: null as Usage | null, llm: null }
  const urgent = blocks.flatMap((b) => b.items).find((i) => i.tag === 'overdue' || i.tag === 'claim' || i.tag === 'money') ?? blocks[0].items[0]
  const res = await complete({
    model,
    temperature: 0.4,
    maxTokens: 120,
    messages: [
      {
        role: 'system',
        content:
          'Write one or two friendly sentences that open the user\'s plan for the day, in the language of the request. ' +
          'Do not list the items (they are shown below your text) and do not invent anything: mention only the most urgent item you are given. Plain text.',
      },
      {
        role: 'user',
        content: JSON.stringify({ request: question, user: user.name.split(' ')[0], items: count, blocks: blocks.map((b) => `${b.title}: ${b.items.length}`), mostUrgent: urgent.text }),
      },
    ],
  })
  const fallback = `${count} item${count === 1 ? '' : 's'} today. Most urgent: ${urgent.text}.`
  const text = res.ok && res.message.content?.trim() ? res.message.content.trim() : fallback
  return { text, blocks, usage: res.ok ? res.usage : null, llm: res }
}
