/** Rebuilds the knowledge-base index (data/index.json) from data/kb/ and
 * data/qa.json, the same incremental rebuild as the Reindex button: only
 * changed documents are re-chunked and re-embedded.
 *
 *   npm run index */
import { loadIndex, rebuildIndex } from '../src/kb.ts'

loadIndex()
const s = await rebuildIndex()
console.log(`+${s.added} added, ${s.changed} changed, ${s.removed} removed, ${s.unchanged} unchanged; embedded ${s.embedded} chunk(s) in ${s.ms} ms`)
