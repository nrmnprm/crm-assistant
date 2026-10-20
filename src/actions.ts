/** Quick actions under an answer: buttons to the CRM screen the question is
 * about. Chosen by keywords, not by the model — a model invents links to
 * screens that do not exist far too easily. At most two. */

const ACTIONS: { label: string; url: string; words: string[] }[] = [
  { label: 'New warranty claim', url: '/claims/new', words: ['warranty', 'claim', 'rma', 'defect', 'broken', 'noise', 'vibration', 'low airflow', 'гарант', 'рекламац', 'брак', 'шум'] },
  { label: 'New quote', url: '/quotes/new', words: ['quote', 'proposal', 'offer', 'select', 'fan for', 'need a fan', 'кп', 'предложен', 'подобр'] },
  { label: 'Request a discount', url: '/quotes/discount', words: ['discount', 'скидк'] },
  { label: 'Reserve stock', url: '/stock/reserve', words: ['reserve', 'reservation', 'hold stock', 'резерв'] },
  { label: 'Overdue invoices', url: '/finance/overdue', words: ['overdue', 'unpaid', 'debt', 'credit hold', 'просроч', 'долг', 'задолж'] },
  { label: 'New IT task', url: '/tasks/new?type=it', words: ['password', 'laptop', 'access', 'it department', 'пароль', 'доступ', 'ноутбук'] },
  { label: 'Time-off request', url: '/profile/requests', words: ['vacation', 'day off', 'sick leave', 'отпуск', 'отгул', 'больнич'] },
]

export function suggestActions(question: string): { label: string; url: string }[] {
  const q = ` ${question.toLowerCase()} `
  const out: { label: string; url: string }[] = []
  for (const a of ACTIONS) {
    if (a.words.some((w) => q.includes(w))) out.push({ label: a.label, url: a.url })
    if (out.length >= 2) break
  }
  return out
}
