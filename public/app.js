/* CRM assistant demo — client. Plain ES module, no build step. */

const $ = (s, el = document) => el.querySelector(s)
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') n.className = v
    else if (k === 'html') n.innerHTML = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else n.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return n
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const usd = (n) => `$${(n ?? 0).toFixed(n && n < 0.01 ? 5 : n < 1 ? 4 : 2)}`

const state = { meta: null, userId: 'u-anna', history: [], busy: false }

/* Presets per role: each shows a different part of the pipeline. */
const PRESETS = {
  'u-anna': [
    'Can we take back a fan that was made to order?',
    'Select a duct fan for 1,200 m³/h at 250 Pa, quieter than 50 dB(A).',
    'What is the status of order 0412?',
    'Does Atlas Construction have overdue invoices?',
    "What's on my plate today?",
    'Кто согласует скидку 10%?',
  ],
  'u-mark': [
    'Как оформить рекламацию?',
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

async function api(path, body, method) {
  const res = await fetch(path, body ? { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
  return j
}

/** Tiny markdown: paragraphs, lists, tables, **bold**, `code`. Input is escaped first. */
function md(text) {
  const lines = esc(text).split('\n')
  let html = ''
  let list = null
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
  const close = () => { if (list) { html += `</${list}>`; list = null } }
  let para = []
  const flush = () => { if (para.length) { html += `<p>${inline(para.join('<br>'))}</p>`; para = [] } }
  const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()))
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trimEnd()
    // A table: a "| a | b |" row followed by a "|---|---|" separator.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush(); close()
      const head = cells(line)
      let body = ''
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) body += `<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join('')}</tr>`
      i--
      html += `<div class="mdtable"><table><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr>${body}</table></div>`
      continue
    }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flush()
      const want = ul ? 'ul' : 'ol'
      // Models put blank lines between numbered items: keep the real number.
      if (list !== want) { close(); html += want === 'ol' ? `<ol start="${parseInt(line, 10) || 1}">` : '<ul>'; list = want }
      html += `<li>${inline((ul ?? ol)[1])}</li>`
    } else if (!line.trim()) {
      flush(); close()
    } else {
      if (list && /^\s{2,}/.test(raw)) { html = html.replace(/<\/li>$/, `<br>${inline(line.trim())}</li>`); continue }
      close(); para.push(line)
    }
  }
  flush(); close()
  return html
}

// ---------- header ----------

function modeBadge() {
  const { llm } = state.meta
  const b = $('#mode')
  if (llm.mode === 'live') {
    b.className = 'badge live'
    b.textContent = `● live · ${llm.model}${llm.embeddings ? ' · hybrid search' : ' · lexical search'}`
  } else {
    b.className = 'badge replay'
    b.textContent = `● replay · ${llm.recordings} recordings`
    b.title = llm.reason || ''
  }
}

function renderUsers() {
  const sel = $('#user')
  sel.replaceChildren(...state.meta.users.map((u) => el('option', { value: u.id, selected: u.id === state.userId }, `${u.name} — ${u.role}`)))
  sel.onchange = () => {
    state.userId = sel.value
    newChat()
    renderChips()
  }
}

// ---------- chat ----------

function newChat() {
  state.history = []
  $('#chat').replaceChildren()
}

function renderChips() {
  $('#chips').replaceChildren(...(PRESETS[state.userId] ?? []).map((q) =>
    el('button', { class: 'chip', type: 'button', onclick: () => { if (!state.busy) { newChat(); ask(q) } } }, q)))
}

function stepsView(trace) {
  return el('div', { class: 'steps' }, trace.steps.map((s) => {
    let detail = null
    if (s.name === 'search' && Array.isArray(s.detail)) {
      detail = el('details', {}, el('summary', {}, 'candidates'),
        el('table', { class: 'cands' }, el('tr', {}, el('td', {}, 'chunk'), el('td', {}, 'score'), el('td', {}, 'lexical'), el('td', {}, 'cosine')),
          s.detail.map((c) => el('tr', { class: c.used ? 'used' : '' }, el('td', {}, (c.used ? '✓ ' : '') + c.title), el('td', {}, c.score), el('td', {}, c.lexical), el('td', {}, c.cosine ?? '—')))))
    } else if (s.name === 'prompt' && s.detail?.system) {
      detail = el('details', {}, el('summary', {}, 'system prompt'), el('pre', {}, s.detail.system))
    } else if (s.name.startsWith('tool ') && s.detail) {
      detail = el('details', {}, el('summary', {}, 'arguments and result'), el('pre', {}, JSON.stringify(s.detail, null, 2)))
    }
    return el('div', { class: s.denied ? 'step denied' : 'step' },
      el('span', { class: s.ok ? 'ok' : 'no' }, s.ok ? '✓' : s.denied ? '⊘' : '!'),
      el('b', {}, s.name),
      el('span', { class: 'ms' }, `${s.ms} ms`),
      el('div', {}, s.denied ? el('span', { class: 'deny', title: 'Refused by the access rules in code, not by the model' }, 'DENIED') : null, s.note, detail))
  }))
}

function feedbackButtons(q, answer) {
  const box = el('span')
  const good = el('button', { type: 'button', title: 'Good answer: save it as a curated answer', onclick: async () => {
    box.textContent = 'saving…'
    try {
      await api('/api/feedback', { userId: state.userId, question: q, answer: answer.text })
      box.textContent = '✓ saved as a curated answer'
    } catch (e) { box.textContent = `error: ${e.message}` }
  } }, '👍 save as curated')
  const bad = el('button', { type: 'button', onclick: () => { box.textContent = 'thanks — noted' } }, '👎')
  box.append(good, ' ', bad)
  return box
}

/** Where a briefing part comes from: [DB] built by code from CRM records, [MODEL] written by the model. */
function srcTag(source) {
  return source === 'model'
    ? el('span', { class: 'srctag model', title: 'Written by the model' }, 'MODEL')
    : el('span', { class: 'srctag db', title: 'Built by code from CRM records' }, 'DB')
}

function botMessage(q, a) {
  const t = a.trace
  const stepsBox = el('div')
  let open = false
  const toggle = el('button', { type: 'button', onclick: () => {
    open = !open
    stepsBox.replaceChildren(open ? stepsView(t) : '')
    toggle.textContent = open ? 'Hide steps' : 'Inspect'
  } }, 'Inspect')
  const label = { live: 'live model', replay: 'replayed recording', cache: 'answer cache', fallback: 'fallback', none: 'no model call' }[t.source]
  const stats = [`${(t.durationMs / 1000).toFixed(1)} s`]
  if (t.usage.llmCalls) stats.push(`${t.usage.llmCalls} call${t.usage.llmCalls > 1 ? 's' : ''}`, `${t.usage.promptTokens + t.usage.completionTokens} tokens`, usd(t.usage.costUsd))
  const tools = t.steps.filter((s) => s.name.startsWith('tool ')).length
  if (tools) stats.push(`${tools} tool call${tools > 1 ? 's' : ''}`)
  return el('div', { class: 'msg bot' },
    el('div', { class: 'bubble' },
      a.textSource ? srcTag(a.textSource) : null,
      el('div', { class: 'md', html: md(a.text) }),
      a.blocks?.length ? el('div', { class: 'blocks' }, a.blocks.map((b) =>
        el('div', { class: 'block' }, el('h4', {}, b.title, ' ', srcTag(b.source)), el('ul', {}, b.items.map((i) => el('li', { class: i.tag }, i.text)))))) : null,
      a.products?.length ? el('div', { class: 'products' }, a.products.map((p) =>
        el('div', { class: 'product' }, el('b', {}, p.code), ' ', el('span', { class: `avail ${p.availability}` }, p.availability.replace('_', ' ')),
          el('small', {}, `$${p.priceUsd} · ${p.availability === 'in_stock' ? `${p.stockQty} in stock` : `in ${p.etaDays} days`} · ${p.noiseDbA} dB(A)`)))) : null,
      (a.sources?.length || a.actions?.length || a.unverifiedCodes?.length) ? el('div', { class: 'foot' },
        a.unverifiedCodes?.length ? el('span', { class: 'warnchip', title: 'Codes in the answer that no tool returned' }, `⚠ unverified: ${a.unverifiedCodes.join(', ')}`) : null,
        a.sources.map((s) => el('span', { class: 'src', title: `${s.type}, score ${s.score}` }, `📄 ${s.title}`)),
        a.actions.map((x) => el('a', { class: 'act', href: '#', title: `CRM screen ${x.url}`, onclick: (e) => e.preventDefault() }, `→ ${x.label}`))) : null,
    ),
    el('div', { class: 'meta' }, el('span', { class: `tag ${t.source}` }, label), stats.join(' · '), toggle, a.kind === 'answer' && t.source !== 'fallback' ? feedbackButtons(q, a) : null),
    stepsBox,
  )
}

async function ask(q) {
  q = q.trim()
  if (!q || state.busy) return
  state.busy = true
  const chat = $('#chat')
  $('.hello', chat)?.remove()
  chat.append(el('div', { class: 'msg user' }, q))
  const typing = el('div', { class: 'typing' }, 'Thinking…')
  chat.append(typing)
  typing.scrollIntoView({ block: 'nearest' })
  $('#q').value = ''
  try {
    const a = await api('/api/chat', { userId: state.userId, question: q, history: state.history })
    const msg = botMessage(q, a)
    typing.replaceWith(msg)
    msg.scrollIntoView({ block: 'nearest' })
    state.history.push({ role: 'user', text: q }, { role: 'assistant', text: a.text })
  } catch (e) {
    typing.replaceWith(el('div', { class: 'msg bot' }, el('div', { class: 'bubble' }, `Error: ${e.message}`)))
  } finally {
    state.busy = false
  }
}

// ---------- knowledge base ----------

async function loadKb() {
  const kb = await api('/api/kb')
  $('#kb-stats').textContent = `${kb.index.docs} documents, ${kb.index.chunks} chunks, ${kb.index.withVectors} with vectors${kb.index.embedModel ? ` (${kb.index.embedModel})` : ' — lexical search only'}.`
  $('#gold').replaceChildren(...kb.gold.map((g) => el('div', { class: 'item' }, el('b', {}, g.question), el('div', {}, g.answer), el('small', {}, `by ${g.createdBy}, ${g.createdAt}`))))
  $('#docs').replaceChildren(...kb.docs.map((d) => el('div', { class: 'item' }, el('b', {}, d.title), el('small', {}, `${d.type} · ${d.words} words · updated ${d.updated} · ${d.tags.join(', ')}`))))
}

// ---------- usage ----------

async function loadUsage() {
  const u = await api('/api/usage')
  const t = u.totals
  const kpi = (v, l) => el('div', { class: 'kpi' }, el('div', { class: 'v' }, v), el('div', { class: 'l' }, l))
  $('#kpis').replaceChildren(
    kpi(t.requests, 'requests'), kpi(t.llmCalls, 'model calls'), kpi(t.tokens.toLocaleString('en-US'), 'tokens'),
    kpi(usd(t.costUsd), 'spent'), kpi(t.cacheHits, 'answers from cache'), kpi(`${usd(t.savedUsd)} · ${t.savedTokens.toLocaleString('en-US')} tok`, 'saved by the cache'),
    kpi(t.avgLatencyMs ? `${(t.avgLatencyMs / 1000).toFixed(1)} s` : '—', 'avg live answer'),
  )
  const table = (id, rows) => $(id).replaceChildren(
    el('tr', {}, el('th', {}, ''), el('th', {}, 'requests'), el('th', {}, 'tokens'), el('th', {}, 'cost'), el('th', {}, 'cached')),
    ...rows.map((r) => el('tr', {}, el('td', {}, r.key), el('td', {}, r.requests), el('td', {}, r.tokens), el('td', {}, usd(r.costUsd)), el('td', {}, r.cached))))
  table('#by-action', u.byAction)
  table('#by-user', u.byUser)
  const name = (id) => state.meta.users.find((x) => x.id === id)?.name ?? id
  $('#recent').replaceChildren(
    el('tr', {}, ['time', 'who', 'action', 'calls', 'tokens', 'cost', 'how', 'question'].map((h) => el('th', {}, h))),
    ...u.recent.map((r) => el('tr', {},
      el('td', {}, r.ts.slice(11, 19)), el('td', {}, name(r.userId)), el('td', {}, r.action), el('td', {}, r.llmCalls),
      el('td', {}, r.promptTokens + r.completionTokens), el('td', {}, usd(r.costUsd)),
      el('td', {}, r.cached ? 'cache' : r.replayed ? 'replay' : r.llmCalls ? 'live' : '—'), el('td', { title: r.question ?? '' }, r.question ?? ''))))
}

// ---------- profiles ----------

/** Tool × profile grid; the server builds it from the profiles and the scope rules the tools enforce. */
function accessView(profiles, access) {
  return el('table', { class: 'access' },
    el('tr', {}, el('th', {}, 'Access by role'), profiles.map((p) => el('th', {}, p.title))),
    access.map((r) => el('tr', { class: r.key === 'finance' ? 'fin' : '' },
      el('td', {}, el('code', {}, r.label)),
      profiles.map((p) => {
        const c = r.cells[p.id]
        return el('td', { class: `lvl ${c.level}` }, el('span', { class: 'cell' }, c.label), c.detail ? el('small', {}, c.detail) : null)
      }))))
}

async function loadProfiles() {
  const { profiles, tools, access } = await api('/api/profiles')
  $('#access').replaceChildren(accessView(profiles, access))
  $('#profiles').replaceChildren(...profiles.map((p) => {
    const model = el('input', { value: p.model ?? '', placeholder: `default (${state.meta.llm.model})` })
    const temp = el('input', { type: 'number', min: 0, max: 1.5, step: 0.1, value: p.temperature })
    const maxT = el('input', { type: 'number', min: 100, max: 4000, step: 100, value: p.maxTokens })
    const fin = el('input', { type: 'checkbox', checked: p.seesFinance })
    const boxes = tools.map((t) => ({ t, box: el('input', { type: 'checkbox', checked: p.tools.includes(t) }) }))
    const prompt = el('textarea', {}, p.prompt)
    const status = el('span', { class: 'muted' })
    return el('div', { class: 'profile' },
      el('h3', {}, `${p.title} `, el('span', { class: 'muted' }, `— ${state.meta.users.filter((u) => u.profileId === p.id).map((u) => u.name).join(', ') || 'nobody'}`)),
      el('div', { class: 'fields' }, el('label', {}, 'Model', model), el('label', {}, 'Temperature', temp), el('label', {}, 'Max tokens', maxT),
        el('label', { style: 'flex-direction:row;align-items:center;gap:6px' }, fin, 'sees customer finances')),
      el('div', { class: 'muted' }, 'Tools'),
      el('div', { class: 'tools' }, boxes.map(({ t, box }) => el('label', {}, box, ' ', t))),
      el('label', {}, 'System prompt', prompt),
      el('div', { class: 'row', style: 'margin-top:8px' },
        el('button', { class: 'primary', type: 'button', onclick: async () => {
          try {
            await api(`/api/profiles/${p.id}`, { model: model.value, temperature: Number(temp.value), maxTokens: Number(maxT.value), seesFinance: fin.checked,
              tools: boxes.filter((b) => b.box.checked).map((b) => b.t), prompt: prompt.value }, 'PUT')
            status.textContent = 'saved'
            const fresh = await api('/api/profiles')
            $('#access').replaceChildren(accessView(fresh.profiles, fresh.access))
          } catch (e) { status.textContent = `error: ${e.message}` }
        } }, 'Save'), status))
  }))
}

// ---------- wiring ----------

function show(view) {
  for (const b of document.querySelectorAll('.nav')) b.classList.toggle('on', b.dataset.view === view)
  for (const v of ['chat', 'kb', 'usage', 'settings']) $(`#view-${v}`).hidden = v !== view
  if (view === 'kb') loadKb()
  if (view === 'usage') loadUsage()
  if (view === 'settings') loadProfiles()
}

async function main() {
  state.meta = await api('/api/meta')
  $('#company').textContent = state.meta.company
  modeBadge()
  renderUsers()
  renderChips()
  for (const b of document.querySelectorAll('.nav')) b.addEventListener('click', () => show(b.dataset.view))
  $('#ask').addEventListener('submit', (e) => { e.preventDefault(); ask($('#q').value) })
  $('#new-chat').addEventListener('click', () => { if (!state.busy) newChat() })
  $('#refresh-usage').addEventListener('click', loadUsage)
  $('#clear-cache').addEventListener('click', async () => { const r = await api('/api/cache/clear', {}); $('#clear-cache').textContent = `Cleared ${r.cleared}`; loadUsage() })
  $('#reindex').addEventListener('click', async () => {
    $('#reindex-status').textContent = 'indexing…'
    const s = await api('/api/reindex', {})
    $('#reindex-status').textContent = `+${s.added} added, ${s.changed} changed, ${s.removed} removed, ${s.unchanged} unchanged; embedded ${s.embedded} chunk(s) in ${s.ms} ms`
    loadKb()
  })
}

main().catch((e) => document.body.prepend(el('div', { style: 'padding:12px;background:#fdecec;color:#c62828' }, `Failed to start: ${e.message}`)))
