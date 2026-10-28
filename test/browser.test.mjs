/**
 * Real Chromium input/IME and Web Animations regressions with DSH's Lexical.
 * Run: node --test test/browser.test.mjs
 * DSH_CHECKOUT defaults to the adjacent deepseek-harness checkout (pnpm install).
 * CHROME_PATH optionally selects a Chrome/Chromium executable. Requires Node 22+.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const checkout = resolve(process.env.DSH_CHECKOUT ?? resolve(root, '../deepseek-harness'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError })
}

async function chromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  for (const candidate of candidates) {
    try { await access(candidate); return candidate } catch { /* Try the next browser. */ }
  }
  throw new Error('Chrome/Chromium was not found. Set CHROME_PATH to its executable path.')
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP socket timed out')) }, 10000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
  })
  let id = 0
  const pending = new Map()
  const failPending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('CDP socket closed'))
    }
    pending.clear()
  }
  socket.addEventListener('close', failPending)
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`CDP ${method} timed out`))
    }, 10000)
    pending.set(requestId, { resolve, reject, timer })
    socket.send(JSON.stringify({ id: requestId, method, params }))
  })
  return {
    send,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
      }
      return result.result.value
    },
    close() { socket.close(); failPending() },
  }
}

test('real Chromium + DSH Lexical regressions', { timeout: 90000 }, async (t) => {
  // Reuse the host's exact Lexical version instead of installing another copy.
  const hostRequire = createRequire(resolve(checkout, 'package.json'))
  let esbuild
  try {
    esbuild = createRequire(hostRequire.resolve('vite'))('esbuild')
  } catch (cause) {
    throw new Error(`Install DSH dependencies in ${checkout}, or set DSH_CHECKOUT to an installed checkout.`, { cause })
  }
  const built = await esbuild.build({
    stdin: {
      contents: await readFile(resolve(here, 'browser-harness.js'), 'utf8'),
      resolveDir: resolve(checkout, 'packages/client/ui-conversation'),
      sourcefile: 'browser-harness.js',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"development"' },
    write: false,
  })
  const client = await readFile(resolve(root, 'client.js'), 'utf8')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 80px; background: white; }
    [data-composer-card] { width: 640px; padding: 20px; border: 1px solid #aaa; }
    [data-composer-input] { min-height: 100px; font: 20px/1.5 sans-serif; }
    [data-shell-overlay] { position: fixed; inset: 0; pointer-events: none; }
  </style></head><body>
    <div data-composer-card><div data-composer-input contenteditable="true" role="textbox"></div>
      <button id="toolbar-button">Plan</button></div><div data-shell-overlay></div>
    <script>
      localStorage.clear();
      window.__ModuleLoader__ = { load({ id, factory }) {
        if (id !== 'dsh-power-type') throw new Error('Unexpected module: ' + id);
        window.__powerTypeModule = factory((name) => {
          if (name !== 'react') throw new Error('Unexpected dependency: ' + name);
          return { createElement(type, props) { return { type, props }; } };
        });
      } };
    </script><script src="/client.js"></script><script src="/harness.js"></script>
  </body></html>`
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const script = path === '/client.js' ? client : path === '/harness.js' ? built.outputFiles[0].text : null
    response.writeHead(200, { 'Content-Type': script === null ? 'text/html' : 'text/javascript', 'Cache-Control': 'no-store' })
    response.end(script ?? html)
  })
  const directory = await mkdtemp(join(tmpdir(), 'dsh-power-type-browser-'))
  let chrome
  let connection
  let chromeClosed
  let chromeError
  let diagnostics = ''
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const base = `http://127.0.0.1:${server.address().port}`
    chrome = spawn(await chromeExecutable(), [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, '--window-size=1024,768', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    chrome.on('error', (error) => { chromeError = error })
    chrome.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000) })
    chromeClosed = new Promise((resolve) => chrome.once('close', resolve))
    const port = await waitFor(async () => {
      if (chromeError) throw chromeError
      if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${diagnostics}`)
      return Number((await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
    }, 'Chrome debugging port')
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      return (await response.json()).find((target) => target.type === 'page')
    }, 'Chrome page target')
    connection = await connect(target.webSocketDebuggerUrl)
    const { send, evaluate } = connection
    await send('Runtime.enable')
    // Keep animation expectations independent of the machine's accessibility setting.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    let navigation = 0
    const fresh = async () => {
      // Navigate away first so an old ready flag cannot satisfy this page's wait.
      await send('Page.navigate', { url: 'about:blank' })
      await waitFor(() => evaluate('location.href === "about:blank"'), 'blank page')
      await send('Page.navigate', { url: `${base}/?case=${++navigation}` })
      await waitFor(() => evaluate('window.__powerTestReady === true'), 'Lexical/plugin initialization')
      await evaluate('__powerTest.editor.focus()')
    }
    const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const press = async (key) => {
      const isEnter = key === 'Enter'
      const code = isEnter ? 'Enter' : `Key${key.toUpperCase()}`
      const windowsVirtualKeyCode = isEnter ? 13 : key.toUpperCase().charCodeAt(0)
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code, windowsVirtualKeyCode,
        text: isEnter ? '\r' : key, unmodifiedText: isEnter ? '\r' : key,
      })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
      await settle()
    }
    const snapshot = () => evaluate('__powerTest.snapshot()')

    await t.test('IME candidates stay quiet and committing 你 counts exactly once', async () => {
      await fresh()
      await send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
      await send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 })
      assert.equal((await snapshot()).stats.combo, 0, 'candidate updates must not count as typing')
      await send('Input.insertText', { text: '你' })
      await settle()
      const result = await snapshot()
      assert.equal(result.text, '你', JSON.stringify(result))
      assert.equal(result.stats.combo, 1, JSON.stringify(result))
      assert.ok(result.stats.particles > 0, 'the committed character must produce particles')
    })

    await t.test('Lexical first character and later native input each count once', async () => {
      await fresh()
      await press('a')
      let result = await snapshot()
      assert.equal(result.text, 'a', JSON.stringify(result))
      assert.equal(result.stats.combo, 1, JSON.stringify(result))
      // A controlled empty-paragraph insertion uses beforeinput without input.
      assert.ok(result.events.some((event) => event.type === 'beforeinput' && event.data === 'a'))
      assert.equal(result.events.filter((event) => event.type === 'input' && event.data === 'a').length, 0)
      await press('b')
      result = await snapshot()
      assert.equal(result.text, 'ab', JSON.stringify(result))
      assert.equal(result.stats.combo, 2, JSON.stringify(result))
      assert.ok(result.events.some((event) => event.type === 'input' && event.data === 'b'), 'exercise beforeinput + input deduplication')
    })

    await t.test('typing warms the text and schedules quiet key ticks', async () => {
      await fresh()
      for (const character of 'abcd') await press(character)
      const typing = await snapshot()
      assert.equal(typing.stats.combo, 4, JSON.stringify(typing))
      assert.ok(typing.stats.heat > 0, 'the streak must warm the text')
      assert.ok(typing.stats.particles > 0)
      assert.ok(typing.stats.sound.played > 0, 'key ticks should schedule in the real browser')
      await press('Enter')
      const impact = await snapshot()
      assert.ok(impact.stats.sound.played > typing.stats.sound.played, 'Enter should add an impact cue')
      assert.ok(impact.stats.waves > 0)
    })

    await t.test('typing warms the current text line and schedules key ticks', async () => {
      await fresh()
      for (const character of 'abcd') await press(character)
      const typing = await snapshot()
      assert.equal(typing.stats.combo, 4, JSON.stringify(typing))
      assert.ok(typing.stats.heat > 0, 'the streak must warm the text')
      assert.ok(typing.stats.particles > 0)
      assert.ok(typing.stats.sound.played > 0, 'key ticks should schedule in the real browser')
      await press('Enter')
      const impact = await snapshot()
      assert.ok(impact.stats.sound.played > typing.stats.sound.played, 'Enter should add an impact cue')
      assert.ok(impact.stats.waves > 0)
    })

    await t.test('toolbar Enter stays quiet while composer Enter produces a burst', async () => {
      await fresh()
      await evaluate('document.querySelector("#toolbar-button").focus()')
      await press('Enter')
      const toolbar = await snapshot()
      assert.equal(toolbar.stats.particles, 0, JSON.stringify(toolbar))
      assert.equal(toolbar.stats.waves, 0, JSON.stringify(toolbar))
      await evaluate('__powerTest.editor.focus()')
      await press('Enter')
      const composer = await snapshot()
      assert.ok(composer.stats.particles > 0, JSON.stringify(composer))
      assert.ok(composer.stats.waves >= 2, JSON.stringify(composer))
    })

    for (const action of ['disable', 'dispose']) {
      await t.test(`${action} immediately cancels plugin animations and preserves host animations`, async () => {
        await fresh()
        // Capture real Animation objects and cancel in the same task, before time can expire them.
        const result = await evaluate(`(() => {
          const editor = __powerTest.editor;
          const host = editor.animate([{ opacity: 1 }, { opacity: 0.8 }], { duration: 60000 });
          const api = __dshPowerType;
          api.burst();
          const plugin = editor.getAnimations().filter(animation => animation !== host);
          const keyframes = plugin.map(animation => animation.effect.getKeyframes());
          ${action === 'disable' ? 'api.setEnabled(false)' : 'api.dispose()'};
          const result = {
            keyframes,
            states: plugin.map(animation => animation.playState),
            hostState: host.playState,
            remaining: editor.getAnimations().length,
            stats: api.stats(),
            removed: window.__dshPowerType === undefined,
          };
          host.cancel();
          return result;
        })()`)
        assert.ok(result.keyframes.some((frames) => frames.some((frame) => 'textShadow' in frame)), 'must exercise the real glow animation')
        assert.ok(result.keyframes.some((frames) => frames.some((frame) => 'translate' in frame || 'transform' in frame)), 'must exercise the real shake animation')
        assert.ok(result.states.every((state) => state === 'idle'), JSON.stringify(result))
        assert.equal(result.hostState, 'running', 'host animation must remain running')
        assert.equal(result.remaining, 1, 'only the host animation should remain')
        assert.equal(result.stats.particles, 0)
        assert.equal(result.stats.waves, 0)
        if (action === 'dispose') assert.equal(result.removed, true)
      })
    }
  } finally {
    connection?.close()
    if (chrome && chrome.exitCode === null && !chromeError) {
      chrome.kill('SIGTERM')
      const forceKill = setTimeout(() => chrome.kill('SIGKILL'), 2000)
      try { await chromeClosed } finally { clearTimeout(forceKill) }
    }
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
