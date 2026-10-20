/** Renders the README screenshots with headless Chrome over the DevTools
 * protocol (no Playwright needed). Start the demo first (`npm start`), then:
 *
 *   npm run screenshots            # docs/assistant.jpg, docs/briefing.jpg, docs/usage.jpg
 *
 * CHROME=/path/to/chrome overrides the browser; THEME=dark for dark shots. */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.env.DEMO_URL ?? 'http://127.0.0.1:4320/'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const THEME = process.env.THEME === 'dark' ? 'dark' : 'light'
const OUT = new URL('../docs/', import.meta.url)
const PORT = 9333

const profile = mkdtempSync(join(tmpdir(), 'crm-shots-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function target(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error('Chrome did not start')
}

const ws = new WebSocket(await target())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map<number, (v: any) => void>()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.error ? Promise.reject(new Error(msg.error.message)) : msg.result)
    pending.delete(msg.id)
  }
})
function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}
async function run(js: string) {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${js} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'script failed')
  return r.result?.value
}
async function shot(name: string) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85 })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
  console.log(`docs/${name}`)
}

const ask = (q: string) => `
  ;[...document.querySelectorAll('.chip')].find((b) => b.textContent.startsWith(${JSON.stringify('__Q__')})).click()
  for (let i = 0; i < 120 && document.querySelector('.typing'); i++) await new Promise((r) => setTimeout(r, 500))`.replace('__Q__', q)
const user = (id: string) => `const s = document.querySelector('#user'); s.value = '${id}'; s.dispatchEvent(new Event('change'))`

try {
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: THEME }] })
  const suffix = THEME === 'dark' ? '-dark' : ''

  await cdp('Page.navigate', { url: URL_ })
  await sleep(2000)
  await run(ask('Select a duct fan'))
  await run(`[...document.querySelectorAll('.meta button')].find((b) => b.textContent === 'Inspect').click()`)
  await sleep(800)
  await shot(`assistant${suffix}.jpg`)

  await cdp('Page.navigate', { url: URL_ })
  await sleep(2000)
  await run(user('u-olga'))
  await run(ask("What's on my plate"))
  await sleep(500)
  await shot(`briefing${suffix}.jpg`)
  await run(ask('Which customers are on credit hold'))
  await run(ask('Who approves a 15%'))
  await run(ask('Who approves a 15%'))

  await run(`document.querySelector('[data-view="usage"]').click()`)
  await sleep(1500)
  await shot(`usage${suffix}.jpg`)
} finally {
  ws.close()
  chrome.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
}
