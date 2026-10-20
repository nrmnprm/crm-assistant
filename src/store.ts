/** Demo data: a fictional ventilation distributor. Everything lives in JSON
 * files under data/ so the demo runs without a database; profiles and gold
 * answers are written back when edited. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type { CatalogModel, Crm, GoldAnswer, KbDoc, Profile, User } from './types.ts'

export const DATA = new URL('../data/', import.meta.url)

function read<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, DATA), 'utf8')) as T
}

function write(name: string, value: unknown) {
  if (process.env.DATA_WRITE === '0') return
  writeFileSync(new URL(name, DATA), JSON.stringify(value, null, 1))
}

export const COMPANY = 'Northwind Air'

export const catalog: CatalogModel[] = read('catalog.json')
export const crm: Crm = read('crm.json')
export const users: User[] = read('users.json')
export const profiles: Profile[] = read('profiles.json')
export const gold: GoldAnswer[] = read('qa.json')

export function userById(id: string): User | undefined {
  return users.find((u) => u.id === id)
}

export function profileOf(user: User): Profile {
  return profiles.find((p) => p.id === user.profileId) ?? profiles[0]
}

export function saveProfiles() {
  write('profiles.json', profiles)
}

export function addGold(answer: GoldAnswer) {
  gold.push(answer)
  write('qa.json', gold)
}

/** Knowledge base articles: markdown files with a small header. */
export function kbDocs(): KbDoc[] {
  const dir = new URL('kb/', DATA)
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const raw = readFileSync(new URL(f, dir), 'utf8')
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
      const head: Record<string, string> = {}
      for (const line of (m?.[1] ?? '').split('\n')) {
        const i = line.indexOf(':')
        if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      return {
        id: `kb:${f.replace(/\.md$/, '')}`,
        title: head.title ?? f,
        type: head.type ?? 'article',
        tags: (head.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        updated: head.updated ?? '',
        body: (m?.[2] ?? raw).trim(),
      }
    })
}
