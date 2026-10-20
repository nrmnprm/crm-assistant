/** Knowledge-base index: chunks with an incremental rebuild, a BM25 lexical
 * index and optional embeddings, searched together.
 *
 * Incremental: every document carries a hash of its title and text; a rebuild
 * re-chunks and re-embeds only changed documents and drops vanished ones, so
 * a scheduled reindex costs nothing when the wiki did not change. The title
 * is part of the hash on purpose: a renamed article must be re-embedded.
 *
 * Hybrid search: 0.55 × cosine + 0.45 × lexical when vectors exist, lexical
 * alone otherwise (no key, provider down). Curated answers get a bonus so they
 * win over wiki chunks that merely mention the same words. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { EMBED_MODEL, embed, llmStatus } from './llm.ts'
import { DATA, gold, kbDocs } from './store.ts'

export interface Chunk {
  id: string
  docId: string
  title: string
  type: string
  text: string
  /** Base64 of a Float32Array (L2-normalised), when embeddings were available. */
  vector?: string
}

interface IndexFile {
  embedModel: string | null
  docs: Record<string, { hash: string; title: string; type: string; chunks: number }>
  chunks: Chunk[]
}

export interface SearchOptions {
  topK?: number
  minScore?: number
  qaBoost?: number
}

export interface Hit {
  chunk: Chunk
  score: number
  lexical: number
  cosine: number | null
}

export interface SearchResult {
  hits: Hit[]
  /** Top 10 by score before the threshold, for the inspector. */
  candidates: Hit[]
  mode: 'hybrid' | 'lexical'
  embedTokens: number
  embedCostUsd: number
}

const INDEX_FILE = new URL('index.json', DATA)
const CHUNK = 700
const OVERLAP = 100
const MIN_CHUNK = 80

// ---- chunking ----

/** Paragraph-packing chunker: paragraphs are joined up to ~700 characters,
 * long paragraphs are cut on sentence ends, and the tail of each chunk is
 * repeated at the start of the next so a fact on a boundary is not lost. */
export function chunkText(text: string): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const pieces: string[] = []
  for (const p of paras) {
    if (p.length <= CHUNK) {
      pieces.push(p)
      continue
    }
    let cur = ''
    for (const s of p.split(/(?<=[.!?])\s+/)) {
      if (cur && cur.length + s.length + 1 > CHUNK) {
        pieces.push(cur)
        cur = ''
      }
      cur = cur ? `${cur} ${s}` : s
    }
    if (cur) pieces.push(cur)
  }
  const chunks: string[] = []
  let cur = ''
  for (const piece of pieces) {
    if (cur && cur.length + piece.length + 2 > CHUNK) {
      chunks.push(cur)
      const tail = cur.slice(-OVERLAP)
      const cut = tail.indexOf(' ')
      cur = cut >= 0 ? `${tail.slice(cut + 1)}\n\n${piece}` : piece
    } else {
      cur = cur ? `${cur}\n\n${piece}` : piece
    }
  }
  if (cur) chunks.push(cur)
  // A short tail is merged back instead of becoming a near-empty chunk.
  if (chunks.length > 1 && chunks[chunks.length - 1].length < MIN_CHUNK) {
    const last = chunks.pop()!
    chunks[chunks.length - 1] += `\n\n${last}`
  }
  return chunks
}

// ---- documents ----

interface SourceDoc {
  id: string
  title: string
  type: string
  text: string
}

function sourceDocs(): SourceDoc[] {
  return [
    ...kbDocs().map((d) => ({ id: d.id, title: d.title, type: d.type, text: d.body })),
    ...gold.map((g) => ({ id: `qa:${g.id}`, title: g.question, type: 'gold answer', text: g.answer })),
  ]
}

function hashDoc(d: SourceDoc): string {
  return createHash('md5').update(`${d.title}\n${d.text}`).digest('hex')
}

// ---- vectors ----

function toB64(v: number[]): string {
  return Buffer.from(new Float32Array(v).buffer).toString('base64')
}

function fromB64(s: string): Float32Array {
  const b = Buffer.from(s, 'base64')
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}

// ---- lexical index ----

const STOP = new Set(
  'a an the and or of to in on for with by at from is are was be can do does how what which who when where why it its this that these those i we you they my our your me us not no yes if as about into than then there their'.split(' '),
)

/** Lowercase words with a light English stemmer (plural, -ing, -ed). */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => !STOP.has(w))
    .map((w) => (w.length > 3 ? w.replace(/(ies|es|s|ing|ed)$/, (m) => (m === 'ies' ? 'y' : '')) : w))
}

interface Lexical {
  df: Map<string, number>
  tf: Map<string, number>[]
  len: number[]
  avg: number
}

let index: IndexFile = { embedModel: null, docs: {}, chunks: [] }
let lexical: Lexical = { df: new Map(), tf: [], len: [], avg: 1 }
const vectors = new Map<string, Float32Array>()

function buildLexical() {
  const df = new Map<string, number>()
  const tf: Map<string, number>[] = []
  const len: number[] = []
  for (const c of index.chunks) {
    // The title counts twice: "Discount approval matrix" should win for "discount approval".
    const words = terms(`${c.title} ${c.title} ${c.text}`)
    const m = new Map<string, number>()
    for (const w of words) m.set(w, (m.get(w) ?? 0) + 1)
    for (const w of m.keys()) df.set(w, (df.get(w) ?? 0) + 1)
    tf.push(m)
    len.push(words.length)
  }
  lexical = { df, tf, len, avg: len.reduce((s, x) => s + x, 0) / Math.max(1, len.length) }
  vectors.clear()
  for (const c of index.chunks) if (c.vector) vectors.set(c.id, fromB64(c.vector))
}

/** BM25 squashed into 0..1 (s / (s + 4)) so that it can be mixed with cosine
 * and compared with a fixed threshold. */
function bm25(i: number, q: string[]): number {
  const k1 = 1.2
  const b = 0.75
  const n = index.chunks.length
  let s = 0
  for (const w of new Set(q)) {
    const f = lexical.tf[i].get(w)
    if (!f) continue
    const idf = Math.log(1 + (n - (lexical.df.get(w) ?? 0) + 0.5) / ((lexical.df.get(w) ?? 0) + 0.5))
    s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * lexical.len[i]) / lexical.avg))
  }
  return s / (s + 4)
}

// ---- load / rebuild ----

export function loadIndex() {
  if (existsSync(INDEX_FILE)) index = JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as IndexFile
  buildLexical()
}

export function indexStats() {
  return {
    docs: Object.keys(index.docs).length,
    chunks: index.chunks.length,
    withVectors: index.chunks.filter((c) => c.vector).length,
    embedModel: index.embedModel,
  }
}

export interface RebuildStats {
  added: number
  changed: number
  removed: number
  unchanged: number
  embedded: number
  embedTokens: number
  costUsd: number
  ms: number
}

/** Incremental rebuild. With an embedding model, chunks of changed documents
 * (and chunks that still lack vectors) are embedded in batches. */
export async function rebuildIndex(): Promise<RebuildStats> {
  const started = Date.now()
  const stats: RebuildStats = { added: 0, changed: 0, removed: 0, unchanged: 0, embedded: 0, embedTokens: 0, costUsd: 0, ms: 0 }
  const docs = sourceDocs()
  // Vectors of different models cannot be mixed: a new embedding model means
  // re-embedding everything, but only when embedding is possible right now.
  const canEmbed = llmStatus().embeddings
  const modelChanged = canEmbed && index.embedModel !== EMBED_MODEL
  const keep = new Map<string, Chunk[]>()
  for (const c of index.chunks) keep.set(c.docId, [...(keep.get(c.docId) ?? []), c])
  const next: IndexFile = { embedModel: canEmbed ? EMBED_MODEL : index.embedModel, docs: {}, chunks: [] }

  for (const d of docs) {
    const hash = hashDoc(d)
    const old = index.docs[d.id]
    let chunks: Chunk[]
    if (old && old.hash === hash && !modelChanged) {
      chunks = keep.get(d.id) ?? []
      stats.unchanged++
    } else {
      chunks = chunkText(d.text).map((text, i) => ({ id: `${d.id}#${i}`, docId: d.id, title: d.title, type: d.type, text }))
      if (old) stats.changed++
      else stats.added++
    }
    next.docs[d.id] = { hash, title: d.title, type: d.type, chunks: chunks.length }
    next.chunks.push(...chunks)
  }
  stats.removed = Object.keys(index.docs).filter((id) => !next.docs[id]).length

  // Embed what has no vector yet; the text sent is "[Title]\nchunk".
  if (modelChanged) for (const c of next.chunks) delete c.vector
  const todo = canEmbed ? next.chunks.filter((c) => !c.vector) : []
  for (let i = 0; i < todo.length; i += 32) {
    const batch = todo.slice(i, i + 32)
    const res = await embed(batch.map((c) => `[${c.title}]\n${c.text}`), 'document')
    if (!res) break
    batch.forEach((c, j) => (c.vector = toB64(res.vectors[j])))
    stats.embedded += batch.length
    stats.embedTokens += res.tokens
    stats.costUsd += res.costUsd ?? 0
  }

  index = next
  if (process.env.DATA_WRITE !== '0') writeFileSync(INDEX_FILE, JSON.stringify(index))
  buildLexical()
  stats.ms = Date.now() - started
  return stats
}

// ---- search ----

export async function search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const topK = opts.topK ?? 5
  const qaBoost = opts.qaBoost ?? 0.15
  const q = terms(query)
  let qVec: Float32Array | null = null
  let embedTokens = 0
  let embedCostUsd = 0
  // Query and documents must come from the same embedding model.
  if (vectors.size && index.embedModel === EMBED_MODEL) {
    const res = await embed([query], 'query')
    if (res) {
      qVec = new Float32Array(res.vectors[0])
      embedTokens = res.tokens
      embedCostUsd = res.costUsd ?? 0
    }
  }
  const mode = qVec ? 'hybrid' : 'lexical'
  // Lexical scores are lower on average than cosine, so each mode has its own bar.
  const minScore = opts.minScore ?? (mode === 'hybrid' ? 0.45 : 0.3)

  const scored: Hit[] = index.chunks.map((chunk, i) => {
    const lex = bm25(i, q)
    let cosine: number | null = null
    const v = vectors.get(chunk.id)
    if (qVec && v && v.length === qVec.length) {
      let dot = 0
      for (let k = 0; k < v.length; k++) dot += v[k] * qVec[k]
      cosine = dot
    }
    let score = cosine == null ? lex : 0.55 * cosine + 0.45 * lex
    if (chunk.docId.startsWith('qa:')) score += qaBoost
    return { chunk, score, lexical: lex, cosine }
  })
  scored.sort((a, b) => b.score - a.score)
  const candidates = scored.slice(0, 10)
  const hits = scored.slice(0, topK).filter((h) => h.score >= minScore)
  return { hits, candidates, mode, embedTokens, embedCostUsd }
}
