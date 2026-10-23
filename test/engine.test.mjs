/**
 * DOM regressions for the browser plugin's public event/lifecycle contract.
 *
 * jsdom cannot emulate an IME or Lexical's browser integration. These tests
 * replay their event orderings and DOM updates; test/browser.test.mjs covers
 * the actual Chromium/Lexical path. Pixel checks live in the capture scripts.
 *
 * Run: node --test test/engine.test.mjs
 * Dependencies: DSH_CHECKOUT (defaults to the sibling ../deepseek-harness).
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const checkout = process.env.DSH_CHECKOUT ?? resolve(root, '../deepseek-harness')
const require = createRequire(resolve(checkout, 'package.json'))
const { JSDOM } = require('jsdom')
const source = await readFile(resolve(root, 'client.js'), 'utf8')
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

function mount(t, { textarea = false } = {}) {
  const editorMarkup = textarea
    ? '<textarea data-composer-input></textarea>'
    : '<div data-composer-input contenteditable="true" role="textbox"></div>'
  const dom = new JSDOM(`<!doctype html><html><body>
    <div data-conversation-content data-conversation-session="session-a">
      <div data-composer-card>${editorMarkup}<button data-toolbar>Attach</button></div>
    </div>
    <div data-shell-overlay></div>
  </body></html>`, {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  })
  const { window } = dom
  const { document } = window
  t.after(() => dom.window.close())
  window.matchMedia = () => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })

  // Leave visual state stable while waiting for input reconciliation tasks.
  let nextFrame = 0
  const frames = new Set()
  window.requestAnimationFrame = () => {
    const id = ++nextFrame
    frames.add(id)
    return id
  }
  window.cancelAnimationFrame = (id) => frames.delete(id)
  const calls = { clearRect: 0 }
  const context = new Proxy({
    measureText: () => ({ width: 12 }),
    clearRect: () => { calls.clearRect += 1 },
  }, {
    get(target, property) {
      return property in target ? target[property] : () => undefined
    },
    set(target, property, value) {
      target[property] = value
      return true
    },
  })
  window.HTMLCanvasElement.prototype.getContext = () => context
  const editor = document.querySelector('[data-composer-input]')
  const conversation = editor.closest('[data-conversation-content]')
  const rect = (left, top, width, height) => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
  })
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this === editor) return rect(20, 20, 600, 28)
    if (this instanceof window.HTMLCanvasElement) return rect(0, 0, 800, 600)
    return rect(0, 0, 0, 0)
  }

  // Model the native Animation lifecycle, including finished rejection on
  // cancel. Every object is visible through getAnimations, so a broad cleanup
  // would incorrectly cancel the unrelated application animation in our tests.
  const animations = []
  class Animation extends window.EventTarget {
    constructor(target) {
      super()
      this.effect = { target }
      this.playState = 'running'
      this.cancelCalls = 0
      this.finished = new Promise((resolve, reject) => {
        this.resolve = resolve
        this.reject = reject
      })
      this.finished.catch(() => {})
    }
    finish() {
      this.playState = 'finished'
      this.resolve(this)
      const event = new window.Event('finish')
      this.dispatchEvent(event)
      this.onfinish?.(event)
    }
    cancel() {
      this.cancelCalls += 1
      this.playState = 'idle'
      this.reject(new window.DOMException('Animation cancelled', 'AbortError'))
      const event = new window.Event('cancel')
      this.dispatchEvent(event)
      this.oncancel?.(event)
    }
  }
  window.Element.prototype.animate = function animate() {
    const animation = new Animation(this)
    animations.push(animation)
    return animation
  }
  window.Element.prototype.getAnimations = function getAnimations({ subtree = false } = {}) {
    return animations.filter((animation) => animation.playState === 'running'
      && (animation.effect.target === this || (subtree && this.contains(animation.effect.target))))
  }

  let module = null
  const React = { createElement: (type, props) => ({ type, props }) }
  window.__ModuleLoader__ = {
    load({ id, factory }) {
      assert.equal(id, 'dsh-power-type')
      module = factory((name) => {
        assert.equal(name, 'react')
        return React
      })
    },
  }
  window.eval(source)
  assert.ok(module, 'module factory should be registered')
  const registrations = []
  module.apply({
    slots: {
      inject(name, contribute) {
        assert.equal(name, 'shell.overlay')
        contribute()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.id, 'power-type')
  const element = registrations[0].component()
  assert.equal(element.type, 'canvas')
  const canvas = document.createElement('canvas')
  document.querySelector('[data-shell-overlay]').append(canvas)
  element.props.ref(canvas)
  const api = window.__dshPowerType
  assert.ok(api, 'mounted overlay should install the runtime API')
  t.after(() => api.dispose())

  function text(value) {
    if (editor instanceof window.HTMLTextAreaElement) editor.value = value
    else editor.textContent = value
  }
  function input(type, options = {}, target = editor) {
    const event = new window.InputEvent(type, {
      bubbles: true,
      cancelable: type === 'beforeinput',
      inputType: 'insertText',
      data: 'a',
      ...options,
    })
    target.dispatchEvent(event)
    return event
  }
  function compose(type, data = '') {
    editor.dispatchEvent(new window.CompositionEvent(type, { bubbles: true, data }))
  }
  function enter(target = editor, options = {}) {
    target.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, ...options,
    }))
  }
  return {
    window, document, conversation, editor, api, calls, animations, frames,
    text, input, compose, enter, unmount: () => element.props.ref(null),
  }
}

function assertEmpty(api, message = 'effects should be empty') {
  const stats = api.stats()
  for (const field of ['combo', 'particles', 'waves', 'ghosts', 'strikes']) {
    assert.equal(stats[field], 0, `${message}: ${field}`)
  }
}

test('mount, ordinary input, Enter, disable and unmount preserve the public contract', async (t) => {
  const f = mount(t)
  f.text('a')
  f.input('input')
  await settle()
  assert.equal(f.api.stats().combo, 1)
  assert.ok(f.api.stats().particles > 0)
  f.enter()
  assert.ok(f.api.stats().waves >= 1)
  f.api.setEnabled(false)
  assert.equal(f.api.enabled, false)
  assertEmpty(f.api)
  assert.equal(f.frames.size, 0, 'disable should stop canvas rendering')
  f.api.setEnabled(true)
  f.unmount()
  assert.equal(f.window.__dshPowerType, undefined)
  assert.ok(f.calls.clearRect > 0)
})

test('IME intermediate text is quiet and a Chromium-style final composing input commits once', async (t) => {
  const f = mount(t)
  f.compose('compositionstart')
  f.text('ni')
  f.input('input', { inputType: 'insertCompositionText', data: 'ni', isComposing: true })
  await settle()
  assertEmpty(f.api, 'uncommitted IME text')
  f.text('你')
  f.input('input', { inputType: 'insertCompositionText', data: '你', isComposing: true })
  f.compose('compositionend', '你')
  await settle()
  assert.equal(f.api.stats().combo, 1)
  assert.equal(f.api.stats().ghost?.char, '你')
})

for (const order of ['input-before-end', 'input-after-end']) {
  for (const inputType of ['insertFromComposition', 'insertText']) {
    test(`IME commit counts once: ${order}, ${inputType}`, async (t) => {
      const f = mount(t)
      f.compose('compositionstart')
      f.text('你')
      if (order === 'input-after-end') f.compose('compositionend', '你')
      f.input('input', { inputType, data: '你', isComposing: false })
      if (order === 'input-before-end') f.compose('compositionend', '你')
      await settle()
      assert.equal(f.api.stats().combo, 1)
      // Identical data from a subsequent real insertion is a new keystroke.
      f.input('beforeinput', { data: '你' })
      f.text('你你')
      f.input('input', { data: '你' })
      await settle()
      assert.equal(f.api.stats().combo, 2, 'deduplication must not swallow the next identical character')
    })
  }
}

for (const inputType of ['insertFromComposition', 'insertText']) {
  test(`IME final input in a later task is deduplicated: ${inputType}`, async (t) => {
    const f = mount(t)
    f.compose('compositionstart')
    f.text('你')
    f.compose('compositionend', '你')
    await settle()
    assert.equal(f.api.stats().combo, 1)
    f.input('input', { inputType, data: '你', isComposing: false })
    await settle()
    assert.equal(f.api.stats().combo, 1, 'later final input describes the already committed text')
    f.input('beforeinput', { data: '你' })
    f.text('你你')
    f.input('input', { data: '你' })
    await settle()
    assert.equal(f.api.stats().combo, 2, 'the next identical character is a distinct insertion')
  })
}

for (const inputType of ['insertFromComposition', 'insertText']) {
  test(`IME beforeinput after compositionend waits for the final DOM update: ${inputType}`, async (t) => {
    const f = mount(t)
    f.compose('compositionstart')
    f.text('ni')
    f.input('input', { inputType: 'insertCompositionText', data: 'ni', isComposing: true })
    f.compose('compositionend', '你')
    f.input('beforeinput', { inputType, data: '你', isComposing: false })
    f.text('你')
    f.input('input', { inputType, data: '你', isComposing: false })
    await settle()
    assert.equal(f.api.stats().combo, 1)
    assert.equal(f.api.stats().ghost?.char, '你')
  })
}

test('cancelling an IME composition does not produce a hit', async (t) => {
  const f = mount(t)
  f.text('existing')
  f.compose('compositionstart')
  f.text('existingni')
  f.input('input', { inputType: 'insertCompositionText', data: 'ni', isComposing: true })
  f.text('existing')
  f.compose('compositionend', '')
  await settle()
  assertEmpty(f.api)
})

test('an IME session in another input does not suppress the composer', async (t) => {
  const f = mount(t)
  const outside = f.document.createElement('textarea')
  f.document.body.append(outside)
  outside.dispatchEvent(new f.window.CompositionEvent('compositionstart', { bubbles: true }))
  f.input('input', { data: '你', inputType: 'insertCompositionText', isComposing: true }, outside)
  assertEmpty(f.api, 'unrelated input must not trigger composer effects')
  f.text('a')
  f.input('input')
  await settle()
  assert.equal(f.api.stats().combo, 1)
  f.enter()
  assert.ok(f.api.stats().waves > 0, 'an unrelated composition must not block Enter in the composer')
})

test('IME candidate-confirming Enter immediately after compositionend does not burst', async (t) => {
  const f = mount(t)
  f.compose('compositionstart')
  f.text('你')
  f.compose('compositionend', '你')
  f.enter()
  await settle()
  assert.equal(f.api.stats().combo, 1)
  assert.equal(f.api.stats().waves, 0, 'Safari-style confirmation Enter must not create a submit wave')
  f.enter()
  assert.ok(f.api.stats().waves > 0, 'a later ordinary Enter still submits')
})

test('IME candidate-confirming Space does not double-count the commit or suppress a later space', async (t) => {
  const f = mount(t)
  f.compose('compositionstart')
  f.text('ni')
  f.input('input', { inputType: 'insertCompositionText', data: 'ni', isComposing: true })
  f.compose('compositionend', '你')
  f.editor.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  f.input('beforeinput', { data: '你' })
  f.text('你')
  f.input('input', { data: '你' })
  await settle()
  assert.equal(f.api.stats().combo, 1)
  f.editor.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  f.input('beforeinput', { data: ' ' })
  f.text('你 ')
  f.input('input', { data: ' ' })
  await settle()
  assert.equal(f.api.stats().combo, 2, 'ordinary inserted whitespace still counts as typing')
})

test('legacy keyCode 229 and composing Enter are ignored without swallowing ordinary Enter', (t) => {
  const f = mount(t)
  f.enter(f.editor, { keyCode: 229 })
  f.enter(f.editor, { isComposing: true })
  assertEmpty(f.api)
  f.enter()
  assert.ok(f.api.stats().waves > 0)
})

test('ordinary keydown, beforeinput and input sequences preserve each typing hit', async (t) => {
  const f = mount(t)
  for (const [data, text] of [['a', 'a'], ['b', 'ab']]) {
    f.editor.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: data, bubbles: true }))
    f.input('beforeinput', { data })
    f.text(text)
    f.input('input', { data })
    f.editor.dispatchEvent(new f.window.KeyboardEvent('keyup', { key: data, bubbles: true }))
    await settle()
  }
  assert.equal(f.api.stats().combo, 2)
  f.enter()
  assert.ok(f.api.stats().waves > 0)
})

for (const textarea of [false, true]) {
  test(`controlled beforeinput with deferred ${textarea ? 'textarea value' : 'contenteditable DOM'} update counts once`, async (t) => {
    const f = mount(t, { textarea })
    f.editor.addEventListener('beforeinput', (event) => {
      event.preventDefault()
      queueMicrotask(() => f.text(event.data))
    })
    const event = f.input('beforeinput')
    assert.equal(event.defaultPrevented, true)
    await settle()
    assert.equal(f.api.stats().combo, 1)
    assert.ok(f.api.stats().particles > 0)
  })
}

test('ordinary beforeinput followed by native input counts once', async (t) => {
  const f = mount(t)
  f.input('beforeinput')
  f.text('a')
  f.input('input')
  await settle()
  assert.equal(f.api.stats().combo, 1)
})

test('blocked beforeinput without a content change does not produce effects', async (t) => {
  const f = mount(t)
  f.editor.addEventListener('beforeinput', (event) => event.preventDefault())
  f.input('beforeinput')
  await settle()
  assertEmpty(f.api)
})

test('deletion and empty insertions do not increase the combo', async (t) => {
  const f = mount(t)
  f.text('ab')
  f.input('beforeinput', { inputType: 'deleteContentBackward', data: null })
  f.text('a')
  f.input('input', { inputType: 'deleteContentBackward', data: null })
  f.input('beforeinput', { data: '' })
  f.input('input', { data: '' })
  await settle()
  assertEmpty(f.api)
})

test('deleting and reinserting an IME-committed character without keydown is a new hit', async (t) => {
  const f = mount(t)
  f.compose('compositionstart')
  f.text('你')
  f.compose('compositionend', '你')
  await settle()
  assert.equal(f.api.stats().combo, 1)
  // Mobile and assistive editing paths need not send a physical keydown.
  f.input('beforeinput', { inputType: 'deleteContentBackward', data: null })
  f.text('')
  f.input('input', { inputType: 'deleteContentBackward', data: null })
  assert.equal(f.api.stats().combo, 1, 'deletion itself is not a typing hit')
  f.input('beforeinput', { data: '你' })
  f.text('你')
  f.input('input', { data: '你' })
  await settle()
  assert.equal(f.api.stats().combo, 2, 'new insertion must not be mistaken for the old IME final input')
})

test('Enter on a card toolbar button does not trigger a submit effect', (t) => {
  const f = mount(t)
  f.enter(f.document.querySelector('[data-toolbar]'))
  assertEmpty(f.api)
  assert.equal(f.animations.length, 0)
  f.enter()
  assert.ok(f.api.stats().waves > 0, 'Enter in the actual editor should still work')
})

for (const control of [
  '<span contenteditable="false"><span data-target>Attachment</span></span>',
  '<span contenteditable="false"><span contenteditable="true" data-target>Nested editable control</span></span>',
  '<span contenteditable="false"><button data-target>Remove attachment</button></span>',
  '<button data-target>Embedded button</button>',
  '<input data-target value="Embedded field">',
]) {
  test(`Enter on an embedded non-editor control is ignored: ${control}`, (t) => {
    const f = mount(t)
    f.editor.innerHTML = control
    f.enter(f.editor.querySelector('[data-target]'))
    assertEmpty(f.api)
    assert.equal(f.animations.length, 0)
  })
}

test('Enter on editable text descendants still triggers the effect', (t) => {
  const f = mount(t)
  f.editor.innerHTML = '<p><strong>editable</strong></p>'
  f.enter(f.editor.querySelector('strong'))
  assert.ok(f.api.stats().waves > 0)
})

for (const lifecycle of ['disable', 'dispose']) {
  test(`${lifecycle} cancels active plugin animations while preserving application animations`, async (t) => {
    const f = mount(t)
    const external = f.editor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000 })
    f.text('a')
    f.input('input')
    await settle()
    const owned = f.animations.slice(1)
    assert.ok(owned.length >= 2, 'typing should create both shake and glow')
    if (lifecycle === 'disable') f.api.setEnabled(false)
    else f.unmount()
    for (const animation of owned) assert.equal(animation.cancelCalls, 1)
    assert.equal(external.cancelCalls, 0, 'cleanup must not cancel another component’s animation')
    assertEmpty(f.api)
    assert.equal(f.frames.size, 0)
  })

  test(`${lifecycle} does not retain already finished or cancelled animations`, async (t) => {
    const f = mount(t)
    f.text('a')
    f.input('input')
    await settle()
    const [finished, cancelled, ...remaining] = f.animations
    assert.ok(finished && cancelled)
    finished.finish()
    cancelled.cancel()
    await settle()
    if (lifecycle === 'disable') f.api.setEnabled(false)
    else f.unmount()
    assert.equal(finished.cancelCalls, 0, 'finished animation should have left the cleanup set')
    assert.equal(cancelled.cancelCalls, 1, 'cancelled animation should have left the cleanup set')
    for (const animation of remaining) assert.equal(animation.cancelCalls, 1)
  })

  for (const pending of ['controlled-input', 'composition-commit']) {
    test(`${lifecycle} prevents pending ${pending} from reviving effects`, async (t) => {
      const f = mount(t)
      if (pending === 'controlled-input') {
        f.editor.addEventListener('beforeinput', (event) => {
          event.preventDefault()
          queueMicrotask(() => f.text(event.data))
        })
        f.input('beforeinput')
      } else {
        f.compose('compositionstart')
        f.text('你')
        f.compose('compositionend', '你')
      }
      if (lifecycle === 'disable') {
        f.api.setEnabled(false)
        // Re-enabling must not make an old queued hit eligible again.
        f.api.setEnabled(true)
      } else {
        f.unmount()
      }
      const animationCount = f.animations.length
      await settle()
      assertEmpty(f.api)
      assert.equal(f.animations.length, animationCount, 'queued work must not start new animations')
      assert.equal(f.frames.size, 0)
    })
  }
}

test('disposal detaches event listeners and a stale runtime API cannot restart effects', async (t) => {
  const f = mount(t)
  f.unmount()
  f.input('beforeinput')
  f.text('a')
  f.input('input')
  f.enter()
  f.compose('compositionstart')
  f.compose('compositionend', '你')
  f.api.burst()
  await settle()
  assertEmpty(f.api)
  assert.equal(f.animations.length, 0)
  assert.equal(f.frames.size, 0)
})

test('session switch clears effects on the resident editor while preserving runtime settings', async (t) => {
  const f = mount(t)
  f.api.setIntensity(1.7)
  const external = f.editor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000 })
  f.text('a')
  f.input('input')
  const owned = f.animations.slice(1)
  assert.equal(f.api.combo, 1)
  assert.ok(f.api.stats().particles > 0)
  assert.ok(owned.length >= 2)

  f.conversation.setAttribute('data-conversation-session', 'session-b')
  await Promise.resolve()

  assert.equal(f.document.querySelector('[data-composer-input]'), f.editor)
  assertEmpty(f.api)
  assert.equal(f.frames.size, 0)
  assert.ok(owned.every(animation => animation.cancelCalls === 1))
  assert.equal(external.cancelCalls, 0, 'session switching must preserve application animations')
  assert.equal(f.api.enabled, true)
  assert.equal(f.api.stats().intensity, 1.7)
})

test('session switch and input in the same task start a fresh combo before observer delivery', async (t) => {
  const f = mount(t)
  f.text('a')
  f.input('input')
  const oldAnimations = [...f.animations]

  f.conversation.setAttribute('data-conversation-session', 'session-b')
  f.text('b')
  f.input('input', { data: 'b' })

  assert.equal(f.api.combo, 1)
  assert.equal(f.api.stats().ghost.char, 'b')
  assert.ok(oldAnimations.every(animation => animation.cancelCalls === 1))
  await settle()
  assert.equal(f.api.combo, 1, 'observer delivery must preserve the new session’s hit')
  assert.ok(f.api.stats().particles > 0)
})

for (const pending of ['controlled-input', 'composition-commit']) {
  test(`session switch cancels pending ${pending} on the resident editor`, async (t) => {
    const f = mount(t)
    if (pending === 'controlled-input') {
      f.editor.addEventListener('beforeinput', (event) => {
        event.preventDefault()
        queueMicrotask(() => f.text(event.data))
      })
      f.input('beforeinput')
    } else {
      f.compose('compositionstart')
      f.text('你')
      f.compose('compositionend', '你')
    }
    f.conversation.setAttribute('data-conversation-session', 'session-b')
    await settle()

    assertEmpty(f.api)
    assert.equal(f.animations.length, 0)
    assert.equal(f.frames.size, 0)
    f.text('你')
    f.input('input', { data: '你' })
    assert.equal(f.api.combo, 1, 'the new session must accept its first character')
  })
}

for (const waitForObserver of [false, true]) {
  test(`session switch releases an active IME composition ${waitForObserver ? 'after' : 'before'} observer delivery`, async (t) => {
    const f = mount(t)
    f.compose('compositionstart')
    f.text('ni')
    f.conversation.setAttribute('data-conversation-session', 'session-b')
    if (waitForObserver) await Promise.resolve()

    f.text('b')
    f.input('input', { data: 'b' })
    assert.equal(f.api.combo, 1, 'the old composition must not suppress ordinary input')
    // A delayed event from the old composition cannot revive its hit.
    f.compose('compositionend', '你')
    await settle()
    assert.equal(f.api.combo, 1)
    assert.equal(f.api.stats().ghost.char, 'b')
  })
}

test('session switch to no selected session clears effects without changing enabled state', async (t) => {
  const f = mount(t)
  f.text('a')
  f.input('input')
  f.conversation.removeAttribute('data-conversation-session')
  await Promise.resolve()
  assertEmpty(f.api)
  assert.equal(f.api.enabled, true)
  assert.equal(f.frames.size, 0)
})

test('session switch while disabled preserves settings and accepts new input after re-enable', async (t) => {
  const f = mount(t)
  f.api.setIntensity(0.6)
  f.text('a')
  f.input('input')
  f.api.setEnabled(false)
  f.conversation.setAttribute('data-conversation-session', 'session-b')
  await settle()
  assertEmpty(f.api)
  assert.equal(f.api.enabled, false)
  assert.equal(f.api.stats().intensity, 0.6)

  f.api.setEnabled(true)
  f.text('b')
  f.input('input', { data: 'b' })
  await settle()
  assert.equal(f.api.combo, 1)
})

test('session switch after unmount cannot clear the canvas or restart effects', async (t) => {
  const f = mount(t)
  f.text('a')
  f.input('input')
  f.conversation.setAttribute('data-conversation-session', 'session-b')
  f.unmount()
  const clearsAfterUnmount = f.calls.clearRect
  const animationsAfterUnmount = f.animations.length
  f.conversation.setAttribute('data-conversation-session', 'session-c')
  f.text('c')
  f.input('input', { data: 'c' })
  await settle()

  assertEmpty(f.api)
  assert.equal(f.calls.clearRect, clearsAfterUnmount, 'disposed observers must not touch the canvas')
  assert.equal(f.animations.length, animationsAfterUnmount)
  assert.equal(f.frames.size, 0)
  assert.equal(f.window.__dshPowerType, undefined)
})

for (const removedNode of ['editor', 'conversation']) {
  test(`removing the active ${removedNode} clears transient effects before the next frame`, async (t) => {
    const f = mount(t)
    f.text('a')
    f.input('input')
    assert.equal(f.api.combo, 1)
    const owned = [...f.animations]

    f[removedNode].remove()
    await Promise.resolve()

    assertEmpty(f.api)
    assert.equal(f.frames.size, 0)
    assert.ok(owned.every(animation => animation.cancelCalls === 1))
    assert.equal(f.api.enabled, true)
  })
}

test('replacing the conversation and typing in the same task starts fresh effects', async (t) => {
  const f = mount(t)
  f.text('a')
  f.input('input')
  const owned = [...f.animations]
  const replacement = f.conversation.cloneNode(true)
  f.conversation.replaceWith(replacement)
  const editor = replacement.querySelector('[data-composer-input]')
  editor.textContent = 'b'
  f.input('input', { data: 'b' }, editor)

  assert.equal(f.api.combo, 1)
  assert.equal(f.api.stats().ghost.char, 'b')
  assert.ok(owned.every(animation => animation.cancelCalls === 1))
  await settle()
  assert.equal(f.api.combo, 1)
  assert.ok(f.api.stats().particles > 0)
})

for (const pending of ['controlled-input', 'composition-commit']) {
  test(`replacing the conversation cancels pending ${pending} from the removed editor`, async (t) => {
    const f = mount(t)
    if (pending === 'controlled-input') {
      f.editor.addEventListener('beforeinput', (event) => {
        event.preventDefault()
        queueMicrotask(() => f.text(event.data))
      })
      f.input('beforeinput')
    } else {
      f.compose('compositionstart')
      f.text('你')
      f.compose('compositionend', '你')
    }
    const replacement = f.conversation.cloneNode(true)
    f.conversation.replaceWith(replacement)
    await settle()

    assertEmpty(f.api)
    assert.equal(f.animations.length, 0)
    assert.equal(f.frames.size, 0)
    const editor = replacement.querySelector('[data-composer-input]')
    editor.textContent = 'b'
    f.input('input', { data: 'b' }, editor)
    assert.equal(f.api.combo, 1)
  })
}
