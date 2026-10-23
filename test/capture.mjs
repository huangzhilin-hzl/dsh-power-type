/**
 * Headless-Chrome capture harness for the plugin demo.
 *
 * `--screenshot` mode advances virtual time but does not give requestAnimationFrame
 * a normal cadence; this script drives a real headless page over CDP instead, so
 * the canvas simulation runs exactly as it does in a browser.
 *
 * Usage: node test/capture.mjs [output.png] [waitMs]
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const output = resolve(root, process.argv[2] ?? 'demo/preview.png')
const waitMs = Number(process.argv[3] ?? 2600)
const port = 9337
const chrome = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = `/tmp/dsh-power-type-chrome-${process.pid}`
const query = process.argv[4] ?? ''
const url = `file://${resolve(root, 'demo/index.html')}${query}`

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const child = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1280,800',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  url,
], { stdio: ['ignore', 'ignore', 'pipe'] })

let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

let socketUrl = null
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    const targets = await response.json()
    const page = targets.find((target) => target.type === 'page')
    if (page !== undefined) {
      socketUrl = page.webSocketDebuggerUrl
      break
    }
  } catch {
    // Chrome is still starting.
  }
  await sleep(100)
}
if (socketUrl === null) {
  child.kill('SIGKILL')
  throw new Error(`Chrome did not expose a page target.\n${stderr}`)
}

const socket = new WebSocket(socketUrl)
let nextId = 1
const pending = new Map()
const exceptions = []

socket.addEventListener('message', (message) => {
  const payload = JSON.parse(message.data)
  if (payload.id !== undefined) {
    const waiter = pending.get(payload.id)
    if (waiter !== undefined) {
      pending.delete(payload.id)
      if (payload.error !== undefined) waiter.reject(new Error(JSON.stringify(payload.error)))
      else waiter.resolve(payload.result)
    }
    return
  }
  if (payload.method === 'Runtime.exceptionThrown') {
    exceptions.push(payload.params.exceptionDetails.text
      + (payload.params.exceptionDetails.exception?.description ?? ''))
  }
})
await new Promise((done, reject) => {
  socket.addEventListener('open', done, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const send = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
  const id = nextId
  nextId += 1
  pending.set(id, { resolve: resolveCall, reject: rejectCall })
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
await send('Page.enable')
await send('Page.bringToFront')
await sleep(waitMs)

const stats = await send('Runtime.evaluate', {
  expression: 'window.__dshPowerType ? JSON.stringify(window.__dshPowerType.stats()) : "no api"',
  returnByValue: true,
})
const hud = await send('Runtime.evaluate', {
  expression: 'document.getElementById("stats").textContent',
  returnByValue: true,
})
const geometry = await send('Runtime.evaluate', {
  expression: `JSON.stringify((() => {
    const editor = document.querySelector('[data-composer-input]')
    const card = document.querySelector('[data-composer-card]')
    const canvas = document.querySelector('[data-dsh-power-type]')
    const style = getComputedStyle(editor)
    const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
    return { editor: rect(editor), card: rect(card), canvas: rect(canvas), translate: style.translate, transform: style.transform, rotate: style.rotate, padding: style.padding, fontSize: style.fontSize, lineHeight: style.lineHeight, scrollLeft: editor.scrollLeft, scrollTop: editor.scrollTop }
  })())`,
  returnByValue: true,
})
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
await mkdir(dirname(output), { recursive: true })
await writeFile(output, Buffer.from(shot.data, 'base64'))

console.log(`stats: ${stats.result.value}`)
console.log(`geometry: ${geometry.result.value}`)
console.log(`hud:\n${hud.result.value}`)
if (exceptions.length > 0) console.log(`exceptions:\n${exceptions.join('\n')}`)
console.log(`wrote ${output}`)

socket.close()
child.kill('SIGKILL')

if (exceptions.length > 0) process.exitCode = 1
