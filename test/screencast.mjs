/**
 * Record the demo as a short animated preview.
 *
 * Usage: node test/screencast.mjs [output.gif] [seconds] [query] [x,y,w,h]
 * Produces the GIF with the system `python3` + Pillow, then removes the frames.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const output = resolve(root, process.argv[2] ?? 'demo/preview.gif')
const seconds = Number(process.argv[3] ?? 3)
const query = process.argv[4] ?? '?speed=110'
const crop = (process.argv[5] ?? '280,450,940,250').split(',').map(Number)
if (crop.length !== 4 || crop.some((value) => !Number.isFinite(value))) throw new Error('crop must be x,y,w,h')
const frameDir = resolve(root, 'demo/.frames')
const port = 9339
const chrome = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = `/tmp/dsh-power-type-gif-${process.pid}`
const url = `file://${resolve(root, 'demo/index.html')}${query}`
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

await rm(frameDir, { recursive: true, force: true })
await mkdir(frameDir, { recursive: true })

const child = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1280,800',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  url,
], { stdio: ['ignore', 'ignore', 'ignore'] })

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
  throw new Error('Chrome did not expose a page target')
}

const socket = new WebSocket(socketUrl)
let nextId = 1
const pending = new Map()
const frames = []

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
  if (payload.method === 'Page.screencastFrame') {
    frames.push(payload.params.data)
    void send('Page.screencastFrameAck', { sessionId: payload.params.sessionId })
  }
})
await new Promise((done, reject) => {
  socket.addEventListener('open', done, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

function send(method, params = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const id = nextId
    nextId += 1
    pending.set(id, { resolve: resolveCall, reject: rejectCall })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

await send('Page.enable')
await send('Page.bringToFront')
await sleep(400)
await send('Page.startScreencast', {
  format: 'png',
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 1,
})
await sleep(seconds * 1000)
await send('Page.stopScreencast')

const sampled = frames.filter((_, index) => index % 3 === 0)
for (let index = 0; index < sampled.length; index += 1) {
  await writeFile(resolve(frameDir, `frame-${String(index).padStart(4, '0')}.png`), Buffer.from(sampled[index], 'base64'))
}
console.log(`captured ${frames.length} frames, using ${sampled.length}`)

socket.close()
child.kill('SIGKILL')

const script = `
from PIL import Image
import glob, os, sys
paths = sorted(glob.glob(${JSON.stringify(resolve(frameDir, 'frame-*.png'))}))
frames = []
for path in paths:
    image = Image.open(path).convert('RGB')
    image = image.crop((${JSON.stringify(crop[0])}, ${JSON.stringify(crop[1])}, ${JSON.stringify(crop[0] + crop[2])}, ${JSON.stringify(crop[1] + crop[3])})).resize((640, ${Math.round(640 * crop[3] / crop[2])}), Image.LANCZOS)
    frames.append(image)
if not frames:
    sys.exit('no frames captured')
frames[0].save(${JSON.stringify(output)}, save_all=True, append_images=frames[1:], duration=50, loop=0, optimize=True)
print('gif bytes', os.path.getsize(${JSON.stringify(output)}))
`
const result = spawnSync('python3', ['-c', script], { stdio: 'inherit' })
await rm(frameDir, { recursive: true, force: true })
console.log(`wrote ${output}`)
if (result.status !== 0) process.exitCode = 1
