export type Availability = 'in_stock' | 'in_transit' | 'on_order'

export interface CatalogModel {
  code: string
  category: string
  name: string
  motor: 'AC' | 'EC'
  /** Performance curve: [airflow m³/h, static pressure Pa], airflow ascending. */
  curve: [number, number][]
  powerW: number
  noiseDbA: number
  voltage: string
  priceUsd: number
  availability: Availability
  stockQty: number
  /** Days until in-transit or made-to-order stock is available. */
  etaDays: number
  maxAirTempC: number
}

export interface Customer {
  id: string
  name: string
  city: string
  segment: string
  managerId: string
  paymentTerms: 'prepayment' | 'net30'
  creditLimitUsd: number
  balanceUsd: number
  onCreditHold: boolean
}

export interface OrderLine {
  code: string
  qty: number
  priceUsd: number
}

export interface Order {
  number: string
  customerId: string
  managerId: string
  status: 'quote' | 'confirmed' | 'awaiting_stock' | 'shipped' | 'delivered'
  createdAt: string
  shipDate: string | null
  lines: OrderLine[]
}

export interface Invoice {
  number: string
  orderNumber: string
  customerId: string
  amountUsd: number
  issuedAt: string
  dueAt: string
  paid: boolean
}

export interface Task {
  id: string
  assigneeId: string
  title: string
  due: string
  done: boolean
  customerId?: string
  kind: 'call' | 'quote' | 'claim' | 'internal'
}

export interface Crm {
  /** The demo clock: "today" for briefings and due dates. */
  today: string
  customers: Customer[]
  orders: Order[]
  invoices: Invoice[]
  tasks: Task[]
}

export interface User {
  id: string
  name: string
  role: string
  profileId: string
}

/** A configuration profile: which model, prompt and tools a group of
 * employees gets. Stored as data, edited from the settings page. */
export interface Profile {
  id: string
  title: string
  model: string | null
  temperature: number
  maxTokens: number
  /** Tool names this profile may use; [] = knowledge base only. */
  tools: string[]
  /** Customer financials (credit limit, balance) are visible. */
  seesFinance: boolean
  prompt: string
}

export interface GoldAnswer {
  id: string
  question: string
  answer: string
  createdBy: string
  createdAt: string
}

export interface KbDoc {
  id: string
  title: string
  type: string
  tags: string[]
  updated: string
  body: string
}

/** Who is calling a tool: access checks use the profile and the user. */
export interface ToolContext {
  userId: string
  profile: Profile
}
