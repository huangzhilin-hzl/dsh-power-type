/** Real DSH CLI/profile/plugin-loader integration. Requires a built DSH checkout and Chrome. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.env.DSH_CHECKOUT ?? join(root, '../deepseek-harness'))
const artifacts = resolve(process.env.DSH_INTEGRATION_ARTIFACTS ?? join(root, 'artifacts/dsh-integration'))
const remotePluginSpec = process.env.DSH_PLUGIN_SPEC?.trim()
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const redact = (text) => String(text).replace(/([?&]token=)[^\s"'&]+/g, '$1[redacted]')
const sha256 = (contents) => createHash('sha256').update(contents).digest('hex')

async function installedPluginEvidence(profile, expectedHash, installSpec) {
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-power-type'), 'CLI adds plugin to real profile bundles')
  const packageManifest = createRequire(join(profile, 'package.json')).resolve('dsh-power-type/package.json')
  const packageDirectory = await realpath(dirname(packageManifest))
  const installed = JSON.parse(await readFile(packageManifest, 'utf8'))
  const clientHash = sha256(await readFile(join(packageDirectory, 'client.js')))
  assert.equal(clientHash, expectedHash, 'installed plugin client must match the expected local source')
  const dependency = manifest.dependencies?.['dsh-power-type']
  const detail = { installSpec, dependency, packageDirectory, version: installed.version, clientSha256: clientHash }
  if (!remotePluginSpec) return detail

  assert.equal(typeof dependency, 'string', 'remote installation records a dependency source')
  assert.doesNotMatch(dependency, /^(?:link|file):/, 'remote installation must not resolve to a local dependency')
  assert.match(dependency, /^(?:github:|git\+https:\/\/|https:\/\/)/, 'dependency records the remote Git source')
  assert.notEqual(packageDirectory, await realpath(root), 'remote installation must not use the local checkout')
  const { parse } = createRequire(join(checkout, 'packages/boot/plugin-manager/package.json'))('yaml')
  const lock = parse(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8'))
  const importer = lock.importers?.['.']?.dependencies?.['dsh-power-type'] ?? lock.dependencies?.['dsh-power-type']
  assert.ok(importer, 'lockfile records the installed plugin')
  const version = typeof importer === 'string' ? importer : importer.version
  const packages = Object.entries(lock.packages ?? {})
    .filter(([key]) => key.startsWith('dsh-power-type@') || key === version || key === `/${version}`)
    .map(([key, value]) => ({ key, resolution: value.resolution }))
  const sources = [{ field: 'importer.version', value: version }]
  for (const entry of packages) {
    sources.push({ field: `packages.${entry.key}`, value: entry.key })
    for (const field of ['commit', 'tarball', 'repo']) {
      sources.push({ field: `packages.${entry.key}.resolution.${field}`, value: entry.resolution?.[field] })
    }
  }
  const commits = sources.flatMap(({ field, value }) => typeof value === 'string'
    ? [...value.matchAll(/(?:^|[\/#@])([a-f\d]{40})(?=$|[\/?#&()\s])/gi)].map(match => ({ commit: match[1].toLowerCase(), field, value }))
    : [])
  const uniqueCommits = [...new Set(commits.map(item => item.commit))]
  assert.equal(uniqueCommits.length, 1, 'remote lockfile must resolve to one full Git commit')
  return { ...detail, resolvedCommit: uniqueCommits[0], commitEvidence: commits, lockfile: { importer, packages } }
}

async function waitFor(check, name, timeout = 15000) {
  const deadline = Date.now() + timeout
  let cause
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value } catch (error) { cause = error }
    await pause(30)
  }
  throw new Error(`Timed out waiting for ${name}`, { cause })
}

async function chromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  for (const path of candidates) {
    try { await access(path); return path } catch { /* Try the next installed browser. */ }
  }
  throw new Error('Install Chrome/Chromium or set CHROME_PATH.')
}

function launch(args, options) {
  const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-30000) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-30000) })
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  return { child, closed, output: () => output }
}

async function stop(process) {
  if (!process || process.child.exitCode !== null) return
  process.child.kill('SIGTERM')
  const escalation = setTimeout(() => process.child.kill('SIGKILL'), 10000)
  try { await process.closed } finally { clearTimeout(escalation) }
}

test('real DSH Web profile integration', { timeout: remotePluginSpec ? 360000 : 240000 }, async (t) => {
  if (process.env.DSH_PLUGIN_SPEC !== undefined) {
    assert.match(remotePluginSpec, /^(?:github:|git\+https:\/\/)/, 'DSH_PLUGIN_SPEC must be a github: or git+https:// remote Git source')
    assert.ok(!process.env.DSH_POWER_TYPE_BASELINE_CLIENT, 'DSH_PLUGIN_SPEC cannot be combined with DSH_POWER_TYPE_BASELINE_CLIENT')
  }
  const require = createRequire(join(checkout, 'package.json'))
  const { chromium } = createRequire(join(checkout, 'apps/web/package.json'))('playwright')
  const loader = pathToFileURL(require.resolve('tsx')).href
  const cli = ['--import', loader, join(checkout, 'apps/cli/src/bin.ts')]
  await access(join(checkout, 'apps/web/dist/index.html'))
  await mkdir(artifacts, { recursive: true })
  const directory = await mkdtemp(join(tmpdir(), 'dsh-power-type-integration-'))
  const evidence = { startedAt: new Date().toISOString(), checkout, assertions: [], errors: [], providerRequests: [] }
  let app
  let install
  let browser
  let page
  let installedPlugin = root
  let readyUrl
  const provider = createServer((request, response) => {
    evidence.providerRequests.push({ method: request.method, path: request.url })
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Power Type integration forbids model calls' } }))
  })
  try {
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
    const environment = {
      ...process.env,
      DSH_HOME: join(directory, '.dsh'),
      DSH_AGENTS_HOME: join(directory, '.agents'),
      TSX_TSCONFIG_PATH: join(checkout, 'tsconfig.json'),
      DEEPSEEK_API_KEY: 'keyless-web-no-call',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
    }
    if (process.env.DSH_TEST_PNPM) {
      const pnpm = resolve(process.env.DSH_TEST_PNPM)
      assert.match(basename(pnpm), /^pnpm(?:\.cmd|\.exe)?$/, 'DSH_TEST_PNPM must name the pnpm executable')
      await access(pnpm)
      environment.PATH = `${dirname(pnpm)}${delimiter}${process.env.PATH ?? ''}`
    }
    if (process.env.DSH_POWER_TYPE_BASELINE_CLIENT) {
      installedPlugin = join(directory, 'baseline-plugin')
      await mkdir(installedPlugin)
      for (const file of ['package.json', 'index.js', 'cordis.patch.yml', 'icon.svg', 'locale']) {
        await cp(join(root, file), join(installedPlugin, file), { recursive: true })
      }
      await cp(process.env.DSH_POWER_TYPE_BASELINE_CLIENT, join(installedPlugin, 'client.js'))
    }
    const client = await readFile(join(installedPlugin, 'client.js'), 'utf8')
    evidence.clientSha256 = sha256(client)
    evidence.baseline = Boolean(process.env.DSH_POWER_TYPE_BASELINE_CLIENT)
    evidence.installSpec = remotePluginSpec ?? installedPlugin
    install = launch([...cli, 'plugin', '--profile', 'web', 'add', evidence.installSpec], { cwd: directory, env: environment })
    const installTimeout = setTimeout(() => { void stop(install) }, remotePluginSpec ? 120000 : 60000)
    let installCode
    try { installCode = await install.closed } finally { clearTimeout(installTimeout) }
    await writeFile(join(artifacts, 'install.log'), redact(install.output()))
    assert.equal(installCode, 0, `Isolated plugin install failed: ${redact(install.output())}`)
    evidence.installation = await installedPluginEvidence(join(directory, '.dsh/profiles/web'), evidence.clientSha256, evidence.installSpec)
    const documents = join(directory, 'Documents')
    await mkdir(documents)
    const fixture = join(directory, 'history-fixture')
    await mkdir(fixture)
    await cp(join(root, 'test/dsh-history-fixture.js'), join(fixture, 'index.js'))
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'power-type-history-fixture', version: '1.0.0', type: 'module', exports: './index.js' }))
    evidence.historyFixture = 'Test-only Host plugin appends one completed empty turn to make real sidebar rows selectable; all session creation, routing, drafts, and rendering use DSH.'
    const isolationPatch = join(directory, 'isolation.patch.yml')
    await writeFile(isolationPatch, `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(documents)}\n- insert:\n    - id: power-type-history-fixture\n      name: ${JSON.stringify(join(fixture, 'index.js'))}\n`)
    app = launch([...cli, 'web', '--patch', join(checkout, 'apps/web/tests/pin-browse-picker.overlay.yml'), '--patch', isolationPatch, '--no-open', '--port', '0'], {
      cwd: directory, env: environment, detached: Boolean(process.env.DSH_KEEP_TEST_APP),
    })
    readyUrl = await Promise.race([waitFor(() => {
      if (app.child.exitCode !== null) throw new Error(`DSH exited: ${redact(app.output())}`)
      return /dsh web: (http:\/\/[^\s]+)/.exec(app.output())?.[1]
    }, 'real DSH server', 90000), app.closed.then(() => { throw new Error(`DSH exited: ${redact(app.output())}`) })])
    const privateUrlPath = join(directory, 'launch-url.txt')
    await writeFile(privateUrlPath, readyUrl, { mode: 0o600 })
    await writeFile('/tmp/dsh-power-type-integration-latest.json', JSON.stringify({ directory, privateUrlPath, pid: app.child.pid, artifacts }))
    t.diagnostic(`DSH ready; private launch URL file: ${privateUrlPath}`)
    evidence.origin = new URL(readyUrl).origin
    browser = await chromium.launch({ executablePath: await chromeExecutable(), headless: true, args: ['--disable-background-timer-throttling'] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'no-preference' })
    page.on('pageerror', error => evidence.errors.push(redact(error.message)))
    const servedPlugin = []
    page.on('response', response => {
      if (!response.url().includes('/plugins/')) return
      void response.text().then(text => {
        if (text.includes("id: 'dsh-power-type'")) servedPlugin.push({ url: new URL(response.url()).pathname, containsCurrentClient: text.includes(client.trim()) })
      }).catch(() => {})
    })
    await page.goto(readyUrl)
    await page.waitForFunction(() => Boolean(window.__dshPowerType), null, { timeout: 60000 })
    const preview = page.getByRole('dialog', { name: 'Preview Notice' })
    // A seeded historical session can dismiss the first-use notice while it animates.
    if (await preview.count()) {
      await preview.getByRole('button', { name: 'Continue', exact: true }).evaluate(button => button.click()).catch(async error => {
        if (await preview.count()) throw error
      })
      await preview.waitFor({ state: 'detached' })
    }
    const rpc = async (endpoint, args) => page.evaluate(async ({ endpoint, args }) => {
      const response = await fetch(`/api/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } }),
      })
      const body = await response.json()
      if (!response.ok || !body.result?.ok) throw new Error(`${endpoint}: ${JSON.stringify(body)}`)
      return body.result.value
    }, { endpoint, args })
    const stats = () => page.evaluate(() => window.__dshPowerType.stats())
    const editor = () => page.locator('[data-composer-input][contenteditable="true"]').first()
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const active = () => page.evaluate(() => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session'))
    const resetEffects = () => page.evaluate(() => { __dshPowerType.setEnabled(false); __dshPowerType.setEnabled(true) })
    const cdp = await page.context().newCDPSession(page)
    const press = async (character) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, code: `Key${character.toUpperCase()}`, windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0), text: character, unmodifiedText: character })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character, code: `Key${character.toUpperCase()}`, windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0) })
      await settle()
    }
    const snapshot = async () => ({ sessionId: await active(), text: await editor().textContent(), stats: await stats() })
    const record = async (name, detail) => { evidence.assertions.push({ name, ...detail }); await writeFile(join(artifacts, 'results.json'), JSON.stringify(evidence, null, 2)) }
    const check = async (name, fn) => t.test(name, async () => {
      try { await fn(); await record(name, { passed: true }) }
      catch (error) { await record(name, { passed: false, error: redact(error.message), snapshot: await snapshot().catch(() => null) }); throw error }
    })

    // The test-only Host plugin closes an empty turn for each created Session.
    // This makes its real sidebar row selectable without issuing a model call.
    const workspaces = []
    for (const name of ['Power Type A', 'Power Type B']) {
      const path = join(directory, name)
      await mkdir(path)
      const { workspace } = await rpc('workspace/create', { request: { path } })
      const { sessionId } = await rpc('session/create', { request: { workspaceId: workspace.workspaceId } })
      await rpc('session/rename', { request: { sessionId, title: name } })
      workspaces.push({ name, ...workspace, sessionId })
    }
    const switchWorkspace = async (workspace) => {
      const group = page.locator(`[data-row-key="workspace:${workspace.workspaceId}"]`)
      if (await group.getAttribute('aria-expanded') === 'false') await group.click()
      const row = page.locator(`[data-row-key="session:${workspace.sessionId}"]`)
      await row.waitFor({ timeout: 15000 })
      await row.click()
      await editor().waitFor({ timeout: 15000 })
      const sessionId = await waitFor(async () => {
        const id = await active()
        return id === workspace.sessionId ? id : undefined
      }, `${workspace.name} selected`)
      await settle()
      return sessionId
    }
    await switchWorkspace(workspaces[0])
    await check('real plugin loader serves current artifact and mounts one canvas', async () => {
      await waitFor(() => servedPlugin.length > 0, 'served plugin source')
      assert.ok(servedPlugin.some(item => item.containsCurrentClient), 'served plugin includes the client file installed by CLI')
      assert.equal(await page.locator('canvas[data-dsh-power-type]').count(), 1)
      assert.equal((await stats()).enabled, true)
      evidence.servedPlugin = servedPlugin
      await page.screenshot({ path: join(artifacts, '01-loaded.png') })
    })
    await check('real Lexical first character and native Chinese IME commit count once', async () => {
      await resetEffects()
      await editor().click()
      await press('a')
      assert.equal(await editor().textContent(), 'a')
      assert.equal((await stats()).combo, 1)
      await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
      await cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 })
      assert.equal((await stats()).combo, 1, 'candidates do not increment combo')
      await cdp.send('Input.insertText', { text: '你' })
      await settle()
      assert.equal(await editor().textContent(), 'a你')
      assert.equal((await stats()).combo, 2)
      assert.ok((await stats()).particles > 0)
      await page.screenshot({ path: join(artifacts, '02-chinese.png') })
    })
    await check('real session navigation preserves drafts and resets effects between A and B', async () => {
      await page.evaluate(() => {
        const editor = document.querySelector('[data-composer-input][contenteditable="true"]')
        const previous = new Set(editor.getAnimations())
        __dshPowerType.burst()
        window.__dshIntegrationAnimations = editor.getAnimations().filter(animation => !previous.has(animation))
      })
      const before = await stats()
      assert.ok(before.particles > 0 && before.waves > 0, 'navigate while effects are active')
      await switchWorkspace(workspaces[1])
      const animations = await page.evaluate(() => window.__dshIntegrationAnimations.map(animation => animation.playState))
      evidence.sessionTransition = { before, after: await stats(), animations }
      assert.notEqual(workspaces[0].sessionId, workspaces[1].sessionId)
      assert.equal((await stats()).combo, 0, 'A combo must not be visible in B')
      for (const effect of ['particles', 'waves', 'ghosts', 'strikes']) assert.equal((await stats())[effect], 0, `${effect} from A must not remain in B`)
      assert.ok(animations.length > 0 && animations.every(state => state === 'idle'), 'navigation cancels outgoing editor animations')
      assert.equal(await editor().textContent(), '')
      await editor().click()
      await press('b')
      assert.equal((await stats()).combo, 1)
      await switchWorkspace(workspaces[0])
      assert.equal(await editor().textContent(), 'a你')
      assert.equal((await stats()).combo, 0, 'B combo must not be visible in A')
      await switchWorkspace(workspaces[1])
      assert.equal(await editor().textContent(), 'b')
      assert.equal((await stats()).combo, 0)
      await page.screenshot({ path: join(artifacts, '03-switched.png') })
    })
    await check('pending insertion checks cannot revive effects after real navigation', async () => {
      evidence.pendingInputMethod = 'Synthetic beforeinput followed by a real sidebar DOM click in the same task; native CDP is used for the separate IME scenario.'
      await switchWorkspace(workspaces[0])
      await resetEffects()
      await page.evaluate((sessionId) => {
        const editor = document.querySelector('[data-composer-input][contenteditable="true"]')
        editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: 'pending', cancelable: true }))
        document.querySelector(`[data-row-key="session:${sessionId}"]`).click()
      }, workspaces[1].sessionId)
      await waitFor(async () => await active() === workspaces[1].sessionId, 'B navigation after pending input')
      await settle()
      assert.equal((await stats()).combo, 0)
      await pause(100)
      assert.equal((await stats()).combo, 0)
      assert.equal((await stats()).particles, 0)
    })
    await check('runtime disable clears animations and survives refresh; intensity also persists', async () => {
      await editor().click()
      const cancellation = await page.evaluate(() => {
        const input = document.querySelector('[data-composer-input][contenteditable="true"]')
        const host = input.animate([{ opacity: 1 }, { opacity: 0.9 }], { duration: 60000 })
        __dshPowerType.burst()
        const owned = input.getAnimations().filter(animation => animation !== host)
        __dshPowerType.setIntensity(1.7)
        __dshPowerType.setEnabled(false)
        const result = { count: owned.length, states: owned.map(animation => animation.playState), hostState: host.playState, stats: __dshPowerType.stats() }
        host.cancel()
        return result
      })
      assert.ok(cancellation.count > 0)
      assert.ok(cancellation.states.every(state => state === 'idle'))
      assert.equal(cancellation.hostState, 'running')
      assert.equal(cancellation.stats.particles, 0)
      assert.equal(cancellation.stats.combo, 0)
      await page.reload()
      await page.waitForFunction(() => Boolean(window.__dshPowerType))
      await editor().waitFor()
      assert.equal((await stats()).enabled, false)
      assert.equal((await stats()).intensity, 1.7)
      assert.equal(await page.locator('canvas[data-dsh-power-type]').count(), 1)
      await editor().click()
      await press('x')
      assert.equal((await stats()).combo, 0)
      await page.evaluate(() => __dshPowerType.setEnabled(true))
      await press('y')
      assert.equal((await stats()).combo, 1)
      await page.screenshot({ path: join(artifacts, '04-reenabled.png') })
    })
    await check('real Plugin Manager disable and enable unmounts and remounts exactly once', async () => {
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      const toggle = page.getByRole('switch', { name: 'Enable Power Type', exact: true })
      await toggle.waitFor()
      const changed = () => page.waitForResponse(response => /\/api\/pluginManager\/set(?:Plugin|Bundle)Enabled$/.test(new URL(response.url()).pathname))
      const disabling = changed()
      await toggle.click()
      evidence.managerDisable = await (await disabling).json()
      await page.waitForFunction(() => window.__dshPowerType === undefined)
      assert.equal(await page.locator('canvas[data-dsh-power-type]').count(), 0)
      await waitFor(async () => await toggle.getAttribute('aria-checked') === 'false' && await toggle.isEnabled(), 'disabled plugin switch to settle')
      const enabling = changed()
      await toggle.click()
      evidence.managerEnable = await (await enabling).json()
      assert.equal(evidence.managerEnable.result.value.enabled, true)
      await page.waitForFunction(() => Boolean(window.__dshPowerType))
      assert.equal(await page.locator('canvas[data-dsh-power-type]').count(), 1)
      assert.equal((await stats()).intensity, 1.7)
      await switchWorkspace(workspaces[1])
      await editor().click()
      await press('z')
      assert.equal((await stats()).combo, 1)
      await page.screenshot({ path: join(artifacts, '05-plugin-remounted.png') })
    })
    assert.deepEqual(evidence.providerRequests, [], 'no model endpoint may be called')
    assert.deepEqual(evidence.errors, [], 'real app reports no uncaught browser errors')
  } catch (error) {
    evidence.failure = redact(error.message)
    throw error
  } finally {
    if (page) await page.screenshot({ path: join(artifacts, 'last-state.png') }).catch(() => {})
    await browser?.close()
    await stop(install)
    if (app) await writeFile(join(artifacts, 'server.log'), redact(app.output()))
    if (process.env.DSH_KEEP_TEST_APP && app?.child.exitCode === null) {
      app.child.stdout.destroy(); app.child.stderr.destroy(); app.child.unref()
      t.diagnostic(`Retained isolated app PID ${app.child.pid}; private temporary directory: ${directory}`)
      evidence.cleanup = { retainedForDebugging: true, pid: app.child.pid, directory }
    } else {
      await stop(app)
      await rm(directory, { recursive: true, force: true })
      evidence.cleanup = { appStopped: true, temporaryHomeRemoved: true, pid: app?.child.pid, directory }
    }
    await new Promise(resolve => provider.close(resolve))
    evidence.finishedAt = new Date().toISOString()
    await writeFile(join(artifacts, 'results.json'), JSON.stringify(evidence, null, 2))
  }
})
