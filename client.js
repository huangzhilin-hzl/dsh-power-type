/**
 * dsh-power-type — typing impact effects for the DSH Web client.
 *
 * The file is already in the Web client's lazy-module format: executing it only
 * registers a factory, and the factory body runs when the module table
 * materializes the plugin. No bundler or build step is involved.
 *
 * Browser half:
 *   1. register one transparent canvas into the shell overlay slot;
 *   2. observe text insertion, IME commits and Enter on the composer;
 *   3. draw sparks, glyph shockwaves and a combo counter on the canvas;
 *   4. shake and glow the editor through the Web Animations API.
 */
window.__ModuleLoader__.load({
  id: 'dsh-power-type',
  factory(require) {
    const React = require('react')

    const PLUGIN_ID = 'dsh-power-type'
    const ENABLED_KEY = 'dsh-power-type.enabled'
    const INTENSITY_KEY = 'dsh-power-type.intensity'
    const SOUND_KEY = 'dsh-power-type.sound'
    const VOLUME_KEY = 'dsh-power-type.volume'
    const TAU = Math.PI * 2
    const IDLE_RESET_MS = 1600
    const COMBO_FADE_MS = 420
    const MAX_PARTICLES = 520
    const HEAT_FULL_COMBO = 20

    // Warm heat ramp; it does not start red, so the reddening is visible.
    const HEAT_STOPS = [
      { at: 0, color: [255, 204, 112] },
      { at: 0.42, color: [255, 146, 58] },
      { at: 0.74, color: [255, 76, 38] },
      { at: 1, color: [255, 32, 24] },
    ]

    const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
    const rand = (low, high) => low + Math.random() * (high - low)
    const pick = (items) => items[(Math.random() * items.length) | 0]
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

    /** Read a persisted boolean setting without letting private mode throw. */
    function readEnabled(win) {
      try {
        return win.localStorage.getItem(ENABLED_KEY) !== '0'
      } catch {
        return true
      }
    }

    /** Read a persisted intensity setting; 1 is the designed default. */
    function readIntensity(win) {
      try {
        const value = Number(win.localStorage.getItem(INTENSITY_KEY))
        return Number.isFinite(value) && value > 0 ? clamp(value, 0.2, 2.5) : 1
      } catch {
        return 1
      }
    }

    /** Sound is part of the impact, but it must always be switchable. */
    function readSoundEnabled(win) {
      try {
        return win.localStorage.getItem(SOUND_KEY) !== '0'
      } catch {
        return true
      }
    }

    /** A deliberately quiet default: the synth sits under the UI, not over it. */
    function readVolume(win) {
      try {
        const raw = win.localStorage.getItem(VOLUME_KEY)
        if (raw === null) return 0.8
        const value = Number(raw)
        return Number.isFinite(value) && value >= 0 ? clamp(value, 0, 1) : 0.8
      } catch {
        return 0.7
      }
    }

    /** Walk the warm heat ramp; the streak turns the text from amber to red. */
    function heatColor(heat) {
      const value = clamp(heat, 0, 1)
      let low = HEAT_STOPS[0]
      let high = HEAT_STOPS[HEAT_STOPS.length - 1]
      for (let index = 1; index < HEAT_STOPS.length; index += 1) {
        if (value <= HEAT_STOPS[index].at) {
          low = HEAT_STOPS[index - 1]
          high = HEAT_STOPS[index]
          break
        }
      }
      const span = Math.max(1e-6, high.at - low.at)
      const mix = clamp((value - low.at) / span, 0, 1)
      return low.color.map((channel, index) => Math.round(channel + (high.color[index] - channel) * mix))
    }

    const rgb = (color, alpha = 1) => `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`
    const heatFor = (combo) => Math.sqrt(clamp((Number(combo) || 0) / HEAT_FULL_COMBO, 0, 1))

    /** Decide whether a CSS color is dark enough to switch the glow blend. */
    function isDarkColor(color) {
      const match = /^rgba?\(([^)]+)\)$/i.exec(color || '')
      if (match === null) return undefined
      const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return undefined
      return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) < 128
    }

    /**
     * Read the live theme tokens. The canvas is drawn outside CSS, so the
     * palette is sampled from the same custom properties the UI uses.
     */
    function readPalette(win, doc) {
      const rootStyle = win.getComputedStyle(doc.documentElement)
      const bodyStyle = win.getComputedStyle(doc.body)
      const dark = isDarkColor(bodyStyle.backgroundColor)
        ?? (typeof win.matchMedia === 'function' && win.matchMedia('(prefers-color-scheme: dark)').matches)
      const token = (name, fallback) => {
        const value = rootStyle.getPropertyValue(name).trim()
        return value.length > 0 ? value : fallback
      }
      return {
        dark,
        accent: token('--dsw-alias-state-business-primary', '#4d93f8'),
        accent2: token('--dsw-alias-brand-primary-new-colorprimary-new-color', '#7aaaff'),
        warm: token('--dsw-static-amber-400', '#f7ad31'),
        hot: token('--dsw-static-red-400', '#f25a5a'),
        cool: token('--dsw-static-green-400', '#4ed17e'),
        text: token('--dsw-alias-label-primary', dark ? '#f4f6fb' : '#101522'),
        pill: dark ? 'rgba(10, 15, 26, 0.78)' : 'rgba(255, 255, 255, 0.9)',
        stroke: dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(16, 21, 34, 0.12)',
      }
    }

    /** Rounded-rectangle path with a manual fallback for older canvases. */
    function roundedRect(context, x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2)
      context.beginPath()
      if (typeof context.roundRect === 'function') {
        context.roundRect(x, y, width, height, r)
        return
      }
      context.moveTo(x + r, y)
      context.arcTo(x + width, y, x + width, y + height, r)
      context.arcTo(x + width, y + height, x, y + height, r)
      context.arcTo(x, y + height, x, y, r)
      context.arcTo(x, y, x + width, y, r)
      context.closePath()
    }

    /** Draw the small lightning mark that prefixes the combo counter. */
    function drawBolt(context, x, y, size, color) {
      context.save()
      context.translate(x, y)
      context.scale(size / 10, size / 10)
      context.fillStyle = color
      context.beginPath()
      context.moveTo(1.4, -5)
      context.lineTo(-3.2, 0.8)
      context.lineTo(-0.4, 0.8)
      context.lineTo(-1.2, 5)
      context.lineTo(3.4, -0.8)
      context.lineTo(0.4, -0.8)
      context.closePath()
      context.fill()
      context.restore()
    }

    /** Resolve the composer editor from an event target. */
    function editorOf(win, target) {
      if (!(target instanceof win.Element)) return null
      const editor = target.closest('[data-composer-input]')
      if (editor === null || editor.getAttribute('contenteditable') === 'false'
        || editor.disabled || editor.readOnly) return null
      for (let node = target; node !== editor; node = node.parentElement) {
        if (node.matches('button, input, select, textarea, [contenteditable="false"]')) return null
      }
      return editor
    }

    /**
     * Measure the caret. A collapsed Range reports the line box in current
     * Chrome, so measure the prefix from the editor start to the caret and use
     * the right edge of its last line fragment instead.
     */
    function caretOf(win, editor) {
      const selection = win.getSelection?.()
      if (selection !== null && selection !== undefined && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        if (editor.contains(range.endContainer)) {
          const prefix = editor.ownerDocument.createRange()
          prefix.selectNodeContents(editor)
          try {
            prefix.setEnd(range.endContainer, range.endOffset)
            const rects = Array.from(prefix.getClientRects())
              .filter((rect) => rect.height > 0 && rect.width >= 0)
            const last = rects[rects.length - 1]
            if (last !== undefined && last.height > 0) {
              return { left: last.right, right: last.right, top: last.top, bottom: last.bottom, width: 0, height: last.height }
            }
          } catch {
            // Node left the editor between selection read and measurement.
          }
        }
      }
      const style = win.getComputedStyle(editor)
      const lineHeight = Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 16) * 1.45
      const box = editor.getBoundingClientRect()
      return { left: box.left + 10, right: box.left + 10, top: box.top + 6, bottom: box.top + 6 + lineHeight, width: 0, height: lineHeight }
    }

    /**
     * A small WebAudio impact synth: a quiet pentatonic key tick and a heavier
     * submit thump. No audio files, no network, no timers.
     */
    function createImpactAudio(win) {
      const BASE_GAIN = 1.0
      const CURVE = 1.6
      const MAX_VOICES = 14
      const TYPE_VOICES = 7
      const SILENT = 0.0001
      const NOISE_SEC = 0.4
      const DEGREES = [0, 2, 4, 7, 9, 12, 14, 16, 19]

      let context = null
      let master = null
      let compressor = null
      let noise = null
      let enabled = true
      let volume = 0.8
      let played = 0
      let dropped = 0
      let paused = false
      let disposed = false
      let lastType = -1
      const voices = new Set()

      const gainFor = () => (enabled ? BASE_GAIN * Math.pow(clamp(volume, 0, 1), CURVE) : SILENT)

      function applyGain() {
        if (context === null || master === null) return
        try {
          master.gain.cancelScheduledValues(context.currentTime)
          master.gain.setTargetAtTime(gainFor(), context.currentTime, 0.012)
        } catch {
          // A closing context can race the last cue.
        }
      }

      function ensure() {
        if (disposed) return false
        try {
          if (context === null) {
            const AudioCtor = win && (win.AudioContext ?? win.webkitAudioContext)
            if (typeof AudioCtor !== 'function') return false
            try {
              context = new AudioCtor({ latencyHint: 'interactive' })
            } catch {
              context = new AudioCtor()
            }
            compressor = context.createDynamicsCompressor()
            compressor.threshold.value = -14
            compressor.knee.value = 12
            compressor.ratio.value = 4
            compressor.attack.value = 0.004
            compressor.release.value = 0.14
            master = context.createGain()
            master.gain.value = gainFor()
            master.connect(compressor)
            compressor.connect(context.destination)
          }
          paused = false
          if (context.state !== 'running' && context.state !== 'closed') {
            const resumed = context.resume?.()
            if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {})
          }
          return true
        } catch {
          try {
            const closed = context?.close?.()
            if (closed && typeof closed.catch === 'function') closed.catch(() => {})
          } catch {
            // A half-built context is unusable.
          }
          context = null
          master = null
          compressor = null
          noise = null
          return false
        }
      }

      function noiseBuffer() {
        if (noise === null) {
          noise = context.createBuffer(1, Math.ceil(context.sampleRate * NOISE_SEC), context.sampleRate)
          const data = noise.getChannelData(0)
          for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1
        }
        return noise
      }

      function own(source, chain) {
        voices.add(source)
        source.onended = () => {
          voices.delete(source)
          for (const node of chain) {
            try { node.disconnect() } catch { /* Already detached. */ }
          }
        }
      }

      function canPlay(limit) {
        if (disposed || !enabled || paused || volume <= 0 || context === null
          || master === null || context.state !== 'running') return false
        if (voices.size >= limit) {
          dropped += 1
          return false
        }
        return true
      }

      function voice(options) {
        if (context === null || master === null) return
        const startsAt = context.currentTime + (options.at || 0)
        const source = options.noise ? context.createBufferSource() : context.createOscillator()
        const filter = context.createBiquadFilter()
        const gain = context.createGain()
        filter.type = options.type || 'lowpass'
        filter.Q.value = options.q
        filter.frequency.setValueAtTime(options.cut, startsAt)
        if (options.noise) {
          source.buffer = noiseBuffer()
        } else {
          source.type = options.wave
          source.frequency.setValueAtTime(options.f0, startsAt)
          if (options.f1 !== options.f0) source.frequency.exponentialRampToValueAtTime(options.f1, startsAt + options.dur)
        }
        gain.gain.setValueAtTime(SILENT, startsAt)
        gain.gain.exponentialRampToValueAtTime(options.gain, startsAt + (options.attack || 0.0025))
        gain.gain.exponentialRampToValueAtTime(SILENT, startsAt + options.dur)
        source.connect(filter)
        filter.connect(gain)
        gain.connect(master)
        if (options.noise) source.start(startsAt, Math.random() * Math.max(0, NOISE_SEC - options.dur - 0.02), options.dur)
        else {
          source.start(startsAt)
          source.stop(startsAt + options.dur + 0.02)
        }
        own(source, [source, filter, gain])
      }

      function stopVoices() {
        for (const source of voices) {
          try {
            source.onended = null
            source.stop(0)
            source.disconnect()
          } catch {
            // Some sources have not started yet.
          }
        }
        voices.clear()
      }

      return {
        ensure,
        setEnabled(next) {
          enabled = next !== false
          if (enabled) paused = false
          else {
            paused = true
            stopVoices()
          }
          applyGain()
          if (enabled && context !== null && context.state === 'suspended') ensure()
          return enabled
        },
        setVolume(next) {
          const value = Number(next)
          if (Number.isFinite(value)) volume = clamp(value, 0, 1)
          applyGain()
          return volume
        },
        /** A short pentatonic blip whose pitch climbs with the streak. */
        type(combo, density = 1) {
          if (!canPlay(TYPE_VOICES)) return
          const now = context.currentTime
          if (now - lastType < 0.022) {
            dropped += 1
            return
          }
          lastType = now
          const count = Math.max(1, Math.min(3, Math.round(Number(density) || 1)))
          const base = Math.max(1, (Number(combo) || 0) - count + 1)
          for (let index = 0; index < count; index += 1) {
            const p = clamp((base + index) / 30, 0, 1)
            const degree = DEGREES[Math.min(DEGREES.length - 1, Math.round(p * (DEGREES.length - 1)) + index)]
            const frequency = 196 * Math.pow(2, degree / 12)
            const at = index * 0.032
            voice({ wave: 'sine', f0: frequency, f1: frequency * 1.02, dur: 0.05, gain: index === 0 ? 0.16 : 0.12, cut: 1600, q: 0.5, attack: 0.005, at })
            voice({ wave: 'sine', f0: frequency * 2, f1: frequency * 2.01, dur: 0.04, gain: index === 0 ? 0.035 : 0.025, cut: 2200, q: 0.5, attack: 0.004, at })
            played += 1
          }
          if ((Number(combo) || 0) > 0 && Number(combo) % 25 === 0) {
            const firstP = clamp(Math.max(1, (Number(combo) || 0) - count + 1) / 30, 0, 1)
            const firstDegree = DEGREES[Math.min(DEGREES.length - 1, Math.round(firstP * (DEGREES.length - 1)))]
            const frequency = 196 * Math.pow(2, firstDegree / 12)
            voice({ wave: 'sine', f0: frequency / 2, f1: frequency / 2, dur: 0.1, gain: 0.05, cut: 900, q: 0.6 })
          }
        },
        /** Submit impact: body weight, paper noise and a bright confirm. */
        impact() {
          if (!canPlay(MAX_VOICES)) return
          played += 1
          // Soft G-major chime over a low body: warm, short and legible without
          // any square/triangle harmonics or bright noise.
          voice({ noise: true, type: 'lowpass', cut: 800, q: 0.4, dur: 0.035, gain: 0.05 })
          voice({ wave: 'sine', f0: 130, f1: 65, dur: 0.22, gain: 0.32, cut: 420, q: 0.5, attack: 0.006 })
          voice({ wave: 'sine', f0: 196, f1: 196, dur: 0.32, gain: 0.36, cut: 1200, q: 0.5, at: 0.02 })
          voice({ wave: 'sine', f0: 293.66, f1: 293.66, dur: 0.28, gain: 0.2, cut: 1400, q: 0.5, at: 0.05 })
          voice({ wave: 'sine', f0: 392, f1: 392, dur: 0.26, gain: 0.14, cut: 1600, q: 0.5, at: 0.1 })
        },
        suspend() {
          paused = true
          stopVoices()
          try {
            if (context !== null && context.state === 'running') {
              const suspended = context.suspend?.()
              if (suspended && typeof suspended.catch === 'function') suspended.catch(() => {})
            }
          } catch {
            // Already closed.
          }
        },
        resume() {
          paused = false
          try {
            if (context !== null && context.state === 'suspended') {
              const resumed = context.resume?.()
              if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {})
            }
          } catch {
            // Already closed.
          }
        },
        dispose() {
          if (disposed) return
          disposed = true
          paused = true
          stopVoices()
          try { master?.disconnect() } catch { /* Already detached. */ }
          try { compressor?.disconnect() } catch { /* Already detached. */ }
          try {
            if (context !== null && context.state !== 'closed') {
              const closed = context.close?.()
              if (closed && typeof closed.catch === 'function') closed.catch(() => {})
            }
          } catch {
            // Already closed.
          }
          context = null
          master = null
          compressor = null
          noise = null
        },
        stats() {
          return {
            ready: context !== null && master !== null && context.state === 'running',
            state: context === null ? 'none' : context.state,
            enabled,
            volume,
            played,
            voices: voices.size,
            dropped,
            paused,
          }
        },
      }
    }

    /**
     * Create the effect engine for one canvas.
     * @param canvas - the transparent overlay canvas.
     * @returns lifecycle controls and the runtime tuning API.
     */
    function createEngine(canvas) {
      const doc = canvas.ownerDocument
      const win = doc.defaultView
      let context = null
      try {
        context = canvas.getContext('2d')
      } catch {
        // No 2D context: the runtime API stays available but draws nothing.
      }
      const motionQuery = typeof win.matchMedia === 'function'
        ? win.matchMedia('(prefers-reduced-motion: reduce)')
        : { matches: false, addEventListener() {}, removeEventListener() {} }
      let reducedMotion = motionQuery.matches

      let enabled = readEnabled(win)
      let intensity = readIntensity(win)
      let palette = readPalette(win, doc)
      let paletteAt = 0
      let width = 0
      let height = 0
      let dpr = 1
      let frame = 0
      let lastFrame = 0
      let disposed = false
      let composition = null
      let compositionEndedAt = -Infinity
      let committedInput = null
      let combo = 0
      let comboExpiresAt = 0
      let comboPop = 0
      let lastEditor = null
      let editorScope = null
      let sessionObserver = null
      let api = null
      let heat = 0
      let impactHeat = 0
      let lineRect = null
      let soundEnabled = readSoundEnabled(win)
      let volume = readVolume(win)

      const particles = []
      const waves = []
      const ghosts = []
      const strikes = []
      const pendingInputs = new Map()
      const animations = new Set()
      const audio = createImpactAudio(win)
      audio.setEnabled(soundEnabled)
      audio.setVolume(volume)

      /** Audio is decorative: a broken graph must never break the animation. */
      function cue(method, ...args) {
        if (!soundEnabled) return false
        try {
          audio.ensure()
          return audio[method](...args)
        } catch {
          return false
        }
      }

      /** One monotonic clock shared by input events and animation frames. */
      const clock = () => win.performance.now()

      /** Resize the backing store to the CSS box and the device pixel ratio. */
      function resize() {
        const box = canvas.getBoundingClientRect()
        dpr = clamp(win.devicePixelRatio || 1, 1, 3)
        width = Math.max(1, Math.round(box.width))
        height = Math.max(1, Math.round(box.height))
        canvas.width = Math.max(1, Math.round(width * dpr))
        canvas.height = Math.max(1, Math.round(height * dpr))
        if (context !== null) context.setTransform(dpr, 0, 0, dpr, 0, 0)
        if (lastEditor !== null && lastEditor.isConnected) lineRect = currentLineRect(lastEditor)
      }

      /** Re-sample theme tokens at most once per second. */
      function refreshPalette(now) {
        if (now - paletteAt < 1000) return
        palette = readPalette(win, doc)
        paletteAt = now
      }

      /** Convert a viewport rect into canvas-local coordinates at text baseline. */
      function pointOf(rect) {
        const box = canvas.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) return null
        const lineHeight = rect.height || 18
        return {
          x: rect.left - box.left + Math.min(rect.width, 2) * 0.5,
          y: rect.top - box.top + lineHeight * 0.8,
          lineHeight,
        }
      }

      /** Spawn the spark burst around one caret point. */
      function spawn(point, count, options) {
        if (reducedMotion || context === null) return
        const total = Math.round(count * intensity)
        for (let index = 0; index < total; index += 1) {
          if (particles.length >= MAX_PARTICLES) particles.shift()
          const angle = rand(-Math.PI * 0.94, -Math.PI * 0.06)
          const speed = rand(70, 285) * options.power
          const streak = Math.random() < 0.3
          particles.push({
            x: point.x + rand(-5, 5),
            y: point.y + rand(-4, 3),
            vx: Math.cos(angle) * speed + rand(-70, 70) * options.spread,
            vy: Math.sin(angle) * speed * rand(0.72, 1.08),
            gravity: rand(700, 980),
            drag: rand(0.984, 0.995),
            size: rand(1.8, 5.4) * (0.7 + options.power * 0.35),
            life: rand(0.34, 0.8),
            age: 0,
            color: Math.random() < 0.16 ? '#ffffff' : pick(options.colors),
            angle: rand(0, TAU),
            spin: rand(-9, 9),
            shape: streak ? 'streak' : 'square',
          })
        }
      }

      /** Push one expanding shockwave ring. */
      function ring(point, radius, color, lineWidth, life) {
        if (reducedMotion) return
        waves.push({
          x: point.x,
          y: point.y,
          from: 3,
          to: radius * (0.75 + intensity * 0.25),
          color,
          lineWidth,
          life,
          age: 0,
        })
      }

      /** Ember particles rise and glow; they share the existing particle loop. */
      function spawnEmbers(point, count, strength, spread = 24) {
        if (reducedMotion || context === null) return
        const total = Math.round(count * intensity)
        const color = rgb(heatColor(strength), 0.95)
        for (let index = 0; index < total; index += 1) {
          if (particles.length >= MAX_PARTICLES) particles.shift()
          particles.push({
            x: point.x + rand(-spread, spread),
            y: point.y + rand(-2, 6),
            vx: rand(-26, 26),
            vy: rand(-92, -34),
            gravity: rand(-105, -38),
            drag: rand(0.986, 0.996),
            size: rand(1, 2.6) * (0.8 + strength * 0.6),
            life: rand(0.34, 0.82),
            age: 0,
            color: Math.random() < 0.22 ? '#fff2c9' : color,
            angle: 0,
            spin: 0,
            shape: 'ember',
          })
        }
      }

      /** Convert the editor's text fragments into canvas-local line boxes. */
      function textLineRects(editor, canvasRect) {
        if (typeof editor.value === 'string') return []
        const range = doc.createRange()
        range.selectNodeContents(editor)
        if (typeof range.getClientRects !== 'function') return []
        return Array.from(range.getClientRects())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .slice(0, 12)
          .map((rect) => ({
            left: rect.left - canvasRect.left,
            top: rect.top - canvasRect.top,
            width: rect.width,
            height: rect.height,
          }))
      }

      /** The line box that contains the caret: the flames follow the text. */
      function currentLineRect(editor) {
        const canvasRect = canvas.getBoundingClientRect()
        const caret = caretOf(win, editor)
        const caretTop = caret.top - canvasRect.top
        const caretBottom = caret.bottom - canvasRect.top
        const lines = textLineRects(editor, canvasRect)
        const matching = lines.filter((line) => caretTop < line.top + line.height && caretBottom > line.top)
        const candidates = matching.length > 0 ? matching : lines.slice(-1)
        if (candidates.length === 0) return null
        const left = Math.min(...candidates.map((line) => line.left))
        const right = Math.max(...candidates.map((line) => line.left + line.width))
        const top = Math.min(...candidates.map((line) => line.top))
        const bottom = Math.max(...candidates.map((line) => line.top + line.height))
        return { left, right, top, bottom, width: right - left, height: bottom - top }
      }

      /** Heat waves and embers rise from the glyphs; no box, no flame shapes. */
      function drawHeat(now) {
        if (context === null || reducedMotion || lastEditor === null || !lastEditor.isConnected) return
        const strength = clamp(heat, 0, 1)
        if (strength < 0.01 && impactHeat < 0.01) return
        const line = lineRect
        if (line === null || line.width <= 0 || textOf(lastEditor).trim().length === 0) return
        const color = heatColor(strength)
        const time = now / 1000
        const power = 0.75 + intensity * 0.3

        context.save()
        context.globalCompositeOperation = palette.dark ? 'lighter' : 'source-over'
        context.lineCap = 'round'

        // Three thin, traveling heat bands above the glyph line.
        const shimmer = heatColor(strength * 0.62)
        for (let band = 0; band < 2; band += 1) {
          const base = line.top - 2 - band * 4 + Math.sin(time * 2.2 + band * 1.7) * 1.4
          context.beginPath()
          for (let x = line.left - 4; x <= line.right + 4; x += 5) {
            const y = base + Math.sin((x - line.left) * 0.038 + time * (2.6 + band) + band * 1.4) * 1.1
            if (x === line.left - 4) context.moveTo(x, y)
            else context.lineTo(x, y)
          }
          context.strokeStyle = rgb(shimmer, (0.2 + strength * 0.26) * (1 - band * 0.16))
          context.lineWidth = 1.1 + strength * 0.3
          context.stroke()
        }

        // Heat wisps peel upward from the baseline.
        const wisps = Math.max(4, Math.min(10, Math.round(line.width / 70)))
        for (let index = 0; index < wisps; index += 1) {
          const phase = time * (1.7 + strength * 1.4) + index * 1.9
          const x = line.left + (index + 0.5) * (line.width / wisps) + Math.sin(phase * 0.7) * 3
          const height = (7 + strength * 21 + impactHeat * 10)
            * (0.38 + 0.62 * Math.abs(Math.sin(phase * 1.2))) * power
          context.beginPath()
          context.moveTo(x, line.top)
          context.bezierCurveTo(
            x + Math.sin(phase) * 3, line.top - height * 0.35,
            x - Math.sin(phase * 1.3) * 4, line.top - height * 0.7,
            x + Math.sin(phase * 1.7) * 5, line.top - height,
          )
          context.strokeStyle = rgb(shimmer, 0.24 + strength * 0.34)
          context.lineWidth = 1.1 + strength * 0.9
          context.stroke()
        }

        // A low, wavy heat line under the text.
        context.beginPath()
        for (let x = line.left; x <= line.right; x += 4) {
          const y = line.bottom - 1.5 + Math.sin((x - line.left) * 0.045 + time * 3.4) * 1.4
          if (x === line.left) context.moveTo(x, y)
          else context.lineTo(x, y)
        }
        context.strokeStyle = rgb(color, 0.22 + strength * 0.36)
        context.lineWidth = 1.4 + strength * 1.1
        context.stroke()

        if (strength > 0.08 && Math.random() < 0.18 + strength * 0.22) {
          spawnEmbers({
            x: line.left + rand(line.width * 0.08, line.width * 0.92),
            y: line.bottom - rand(2, 8),
          }, 1, strength, 4)
        }
        context.restore()
        context.globalAlpha = 1
        context.shadowBlur = 0
      }

      /** Push the small cross-shaped hit marker at the caret. */
      function strike(point, color, power) {
        if (reducedMotion) return
        strikes.push({
          x: point.x,
          y: point.y - point.lineHeight * 0.32,
          color,
          power,
          life: 0.2,
          age: 0,
        })
      }

      /** Push one oversized ghost glyph that snaps down onto the typed line. */
      function ghost(point, char, editor, color, power) {
        if (reducedMotion || context === null) return
        const style = win.getComputedStyle(editor)
        const size = clamp(Number.parseFloat(style.fontSize) || 16, 12, 44)
        const family = style.fontFamily || 'sans-serif'
        const weight = style.fontWeight || '400'
        context.save()
        context.font = `${weight} ${size}px ${family}`
        const charWidth = context.measureText(char).width || size * 0.6
        context.restore()
        // One live glyph: a trail of ghosts reads as corrupted text.
        ghosts.length = 0
        ghosts.push({
          char,
          x: point.x - charWidth * 0.5,
          y: point.y,
          size,
          family,
          weight,
          color,
          life: 0.24,
          age: 0,
          rotation: rand(-0.08, 0.08),
          power,
        })
      }

      /** Own only this plugin's animations, releasing finished/cancelled ones. */
      function trackAnimation(animation) {
        animations.add(animation)
        const release = () => {
          animations.delete(animation)
          animation.removeEventListener('finish', release)
          animation.removeEventListener('cancel', release)
        }
        animation.addEventListener('finish', release)
        animation.addEventListener('cancel', release)
      }

      function cancelAnimations() {
        for (const animation of animations) animation.cancel()
        animations.clear()
      }

      /** Animate the inherited text shadow without touching layout. */
      function glow(editor, color, blur, duration) {
        if (typeof editor.animate !== 'function') return
        const amount = reducedMotion ? 0.4 : 1
        try {
          const outer = rgb(heatColor(combo >= 20 ? 1 : combo >= 8 ? 0.6 : 0.3), palette.dark ? 0.35 : 0.28)
          const core = palette.dark ? 'rgba(255,246,213,.42)' : 'rgba(255,246,213,0)'
          trackAnimation(editor.animate([
            { textShadow: '0 0 0 transparent' },
            {
              textShadow: `0 0 ${blur * 0.25 * amount}px ${core}, 0 0 ${blur * 0.6 * amount}px ${color}, 0 0 ${blur * 0.95 * amount}px ${outer}`,
              offset: 0.18,
            },
            { textShadow: '0 0 0 transparent' },
          ], { duration: duration + 80, easing: 'ease-out' }))
        } catch {
          // Web Animations without text-shadow support: the particles still carry the hit.
        }
      }

      /** Shake only the editor element; independent translate/rotate keep layout intact. */
      function shake(editor, power, submit) {
        if (reducedMotion || typeof editor.animate !== 'function') return
        const strength = clamp(power, 0.6, 2.3)
        const amount = Math.min(intensity, 1.6)
        const amplitude = (submit ? 4.8 : 2.2) * strength * amount
        const rotation = (submit ? 1.0 : 0.55) * strength
        const individual = win.CSS?.supports?.('translate', '1px 1px') === true
          && win.CSS?.supports?.('rotate', '1deg') === true
        const frames = individual
          ? [
              { translate: '0px 0px', rotate: '0deg' },
              { translate: `${rand(-amplitude, amplitude).toFixed(2)}px ${rand(-amplitude * 0.45, amplitude * 0.25).toFixed(2)}px`, rotate: `${rand(-rotation, rotation).toFixed(2)}deg`, offset: 0.18 },
              { translate: `${(rand(-amplitude, amplitude) * 0.55).toFixed(2)}px ${(rand(-amplitude * 0.3, amplitude * 0.2)).toFixed(2)}px`, rotate: `${(rand(-rotation, rotation) * 0.55).toFixed(2)}deg`, offset: 0.45 },
              { translate: `${(rand(-amplitude, amplitude) * 0.25).toFixed(2)}px ${(rand(-amplitude * 0.15, amplitude * 0.1)).toFixed(2)}px`, rotate: `${(rand(-rotation, rotation) * 0.25).toFixed(2)}deg`, offset: 0.72 },
              { translate: '0px 0px', rotate: '0deg' },
            ]
          : [
              { transform: 'translate(0, 0) rotate(0deg)' },
              { transform: `translate(${rand(-amplitude, amplitude).toFixed(2)}px, ${rand(-amplitude * 0.45, amplitude * 0.25).toFixed(2)}px) rotate(${rand(-rotation, rotation).toFixed(2)}deg)`, offset: 0.18 },
              { transform: `translate(${(rand(-amplitude, amplitude) * 0.55).toFixed(2)}px, ${(rand(-amplitude * 0.3, amplitude * 0.2)).toFixed(2)}px) rotate(${(rand(-rotation, rotation) * 0.55).toFixed(2)}deg)`, offset: 0.45 },
              { transform: `translate(${(rand(-amplitude, amplitude) * 0.25).toFixed(2)}px, ${rand(-amplitude * 0.15, amplitude * 0.1).toFixed(2)}px) rotate(${(rand(-rotation, rotation) * 0.25).toFixed(2)}deg)`, offset: 0.72 },
              { transform: 'translate(0, 0) rotate(0deg)' },
            ]
        try {
          trackAnimation(editor.animate(frames, {
            duration: submit ? 380 : 120 + Math.min(combo, 30) * 4,
            easing: 'cubic-bezier(.2, .85, .25, 1)',
          }))
        } catch {
          // A browser without these animation properties still keeps particles and glow.
        }
      }

      /** Reset the streak and let the last combo pill fade out. */
      function resetCombo() {
        combo = 0
        comboExpiresAt = 0
        comboPop = 0
      }

      /** Transient feedback never crosses an editor or session boundary. */
      function resetEffects() {
        clearPendingInputs()
        cancelAnimations()
        resetCombo()
        heat = 0
        impactHeat = 0
        lineRect = null
        audio.suspend()
        particles.length = 0
        waves.length = 0
        ghosts.length = 0
        strikes.length = 0
        if (frame !== 0) win.cancelAnimationFrame(frame)
        frame = 0
        lastFrame = 0
        clear()
      }

      /** DSH can bind a resident composer DOM node to a different session. */
      function syncEditor(editor) {
        if (disposed) return false
        const connected = editor?.isConnected ? editor : null
        const container = connected?.closest('[data-conversation-content], [data-conversation-session]') ?? null
        const sessionId = container?.getAttribute('data-conversation-session') ?? null
        if (editorScope === null && connected === null) return true
        const ancestors = []
        for (let node = connected; node !== null; node = node.parentNode) ancestors.push(node)
        const sameScope = editorScope?.editor === connected && editorScope.container === container
          && editorScope.sessionId === sessionId
        if (sameScope && ancestors.length === editorScope.ancestors.length
          && ancestors.every((node, index) => node === editorScope.ancestors[index])) return true
        if (!sameScope) {
          resetEffects()
          lastEditor = connected
        }
        editorScope = connected === null ? null : { editor: connected, container, sessionId, ancestors }
        sessionObserver?.disconnect()
        if (connected !== null && sessionObserver !== null) {
          // Watch ancestor removal and the session marker, not transcript subtree updates.
          for (const node of ancestors) {
            sessionObserver.observe(node, node === container
              ? { childList: true, attributes: true, attributeFilter: ['data-conversation-session'] }
              : { childList: true })
          }
        }
        return sameScope
      }

      /** Register one keystroke: particles, glyph, ring, glow and shake. */
      function hit(editor, data, kind, playSound = true) {
        if (!enabled || disposed || !editor.isConnected) return
        syncEditor(editor)
        const now = clock()
        refreshPalette(now)
        const point = pointOf(caretOf(win, editor))
        if (point === null) return
        lastEditor = editor
        lineRect = currentLineRect(editor)

        const chars = Array.from(data)
        const glyphCount = Math.max(1, chars.filter((char) => char.trim().length > 0).length)
        const density = kind === 'type' ? Math.min(4, glyphCount) : 1
        if (kind === 'type') {
          if (now > comboExpiresAt) combo = 0
          combo += density
          comboExpiresAt = now + IDLE_RESET_MS
          comboPop = 1
        } else {
          comboExpiresAt = Math.max(comboExpiresAt, now + 1200)
          comboPop = 1
        }

        const strength = kind === 'submit' ? 2 : clamp(0.7 + combo * 0.012, 0.7, 1.5)
        const accent = combo >= 20 ? palette.hot : combo >= 8 ? palette.warm : palette.accent
        const fire = rgb(heatColor(heatFor(combo)))
        const visible = chars.filter((char) => char.trim().length > 0).at(-1) ?? ''

        if (kind === 'submit') {
          heat = Math.min(1, Math.max(heat, 0.4 + combo / 80))
          impactHeat = 1
          if (playSound) cue('impact', combo)
          ring(point, 96, fire, 3.4, 0.55)
          ring(point, 52, palette.warm, 2, 0.4)
          spawn(point, 34 + Math.min(28, combo * 0.5), {
            power: 1.7,
            spread: 1.2,
            colors: [palette.hot, fire, palette.warm, '#fff2c9'],
          })
          spawnEmbers({ x: point.x, y: point.y - 8 }, 16 + Math.min(16, combo * 0.3), 1, 48)
          strike(point, palette.hot, 2.6)
          shake(editor, 2.4, true)
          glow(editor, rgb(heatColor(1), 0.6), 18, 320)
        } else {
          heat = Math.max(heat, heatFor(combo) * (0.72 + Math.random() * 0.18))
          if (playSound) cue('type', combo, density)
          if (combo % 3 === 0) ring(point, 18 + strength * 12, accent, 1 + strength * 0.5, 0.28)
          spawn(point, 4 + Math.min(4, combo * 0.04), {
            power: strength,
            spread: 0.85,
            colors: [accent, fire, palette.warm, palette.hot],
          })
          if (lineRect !== null) {
            spawnEmbers({
              x: lineRect.left + rand(lineRect.width * 0.1, lineRect.width * 0.9),
              y: lineRect.bottom - 4,
            }, 2 + Math.min(6, combo * 0.1), heatFor(combo), 22)
          }
          if (visible.length > 0) ghost(point, visible, editor, accent, strength)
          strike(point, accent, strength)
          shake(editor, strength, false)
          glow(editor, rgb(heatColor(heatFor(combo)), 0.58), 6 + strength * 6, 190)
          if (combo > 0 && combo % 25 === 0) {
            ring(point, 92, palette.warm, 2.6, 0.55)
            strike(point, palette.warm, 2.8)
            spawn(point, 26, {
              power: 1.8,
              spread: 1.3,
              colors: [palette.warm, palette.hot, fire, '#fff2c9'],
            })
            spawnEmbers({ x: point.x, y: point.y - 8 }, 20, 1, 36)
            shake(editor, 2.2, false)
            heat = 1
          }
        }
        ensureFrame()
      }

      /** Drive the simulation and render one frame. */
      function tick(now) {
        frame = 0
        if (disposed) return
        const delta = lastFrame === 0 ? 1 / 60 : clamp((now - lastFrame) / 1000, 0, 0.05)
        lastFrame = now
        update(delta, now)
        render(now)
        if (needsFrame(now)) {
          frame = win.requestAnimationFrame(tick)
        } else {
          lastFrame = 0
          clear()
        }
      }

      /** Advance particles, rings, ghosts and the combo decay. */
      function update(delta, now) {
        for (let index = particles.length - 1; index >= 0; index -= 1) {
          const particle = particles[index]
          particle.age += delta
          if (particle.age >= particle.life || particle.y > height + 60) {
            particles.splice(index, 1)
            continue
          }
          particle.vy += particle.gravity * delta
          const drag = Math.pow(particle.drag, delta * 60)
          particle.vx *= drag
          particle.vy *= drag
          particle.x += particle.vx * delta
          particle.y += particle.vy * delta
          particle.angle += particle.spin * delta
        }
        for (let index = waves.length - 1; index >= 0; index -= 1) {
          const wave = waves[index]
          wave.age += delta
          if (wave.age >= wave.life) waves.splice(index, 1)
        }
        for (let index = ghosts.length - 1; index >= 0; index -= 1) {
          const ghostEntry = ghosts[index]
          ghostEntry.age += delta
          if (ghostEntry.age >= ghostEntry.life) ghosts.splice(index, 1)
        }
        for (let index = strikes.length - 1; index >= 0; index -= 1) {
          const marker = strikes[index]
          marker.age += delta
          if (marker.age >= marker.life) strikes.splice(index, 1)
        }
        comboPop *= Math.pow(0.0008, delta)
        const targetHeat = heatFor(combo)
        const response = targetHeat > heat ? 1 - Math.pow(0.002, delta) : 1 - Math.pow(0.08, delta)
        heat += (targetHeat - heat) * response
        impactHeat *= Math.pow(0.02, delta)
        if (combo > 0 && now > comboExpiresAt + COMBO_FADE_MS) resetCombo()
      }

      /** Whether the loop must stay alive for one more frame. */
      function needsFrame(now) {
        return particles.length > 0
          || waves.length > 0
          || ghosts.length > 0
          || strikes.length > 0
          || (combo > 0 && now < comboExpiresAt + COMBO_FADE_MS)
          || comboPop > 0.01
          || heat > 0.005
          || impactHeat > 0.005
      }

      /** Clear the full backing store. */
      function clear() {
        if (context === null) return
        context.setTransform(dpr, 0, 0, dpr, 0, 0)
        context.clearRect(0, 0, width, height)
      }

      /** Start the loop unless it is already running. */
      function ensureFrame() {
        if (disposed || frame !== 0) return
        lastFrame = 0
        frame = win.requestAnimationFrame(tick)
      }

      /** Draw one frame in CSS-pixel coordinates. */
      function render(now) {
        if (context === null) return
        context.setTransform(dpr, 0, 0, dpr, 0, 0)
        context.clearRect(0, 0, width, height)
        context.globalAlpha = 1

        for (const wave of waves) {
          const progress = easeOutCubic(clamp(wave.age / wave.life, 0, 1))
          const radius = wave.from + (wave.to - wave.from) * progress
          context.globalAlpha = (1 - progress) * 0.85
          context.strokeStyle = wave.color
          context.lineWidth = wave.lineWidth * (1 - progress * 0.55)
          context.beginPath()
          context.ellipse(wave.x, wave.y, radius, radius * 0.72, 0, 0, TAU)
          context.stroke()
        }

        for (const marker of strikes) {
          const progress = clamp(marker.age / marker.life, 0, 1)
          const length = (7 + 16 * marker.power) * (1 - progress * 0.25)
          context.globalAlpha = (1 - progress) * 0.9
          context.strokeStyle = marker.color
          context.lineWidth = 1.4
          context.lineCap = 'round'
          context.beginPath()
          context.moveTo(marker.x - length, marker.y)
          context.lineTo(marker.x + length, marker.y)
          context.stroke()
          context.globalAlpha = (1 - progress) * 0.55
          context.beginPath()
          context.moveTo(marker.x, marker.y - length * 0.7)
          context.lineTo(marker.x, marker.y + length * 0.22)
          context.stroke()
        }

        for (const particle of particles) {
          const progress = clamp(particle.age / particle.life, 0, 1)
          context.globalAlpha = Math.pow(1 - progress, 1.35)
          context.fillStyle = particle.color
          if (particle.shape === 'ember') {
            context.save()
            context.globalAlpha = Math.pow(1 - progress, 1.2) * 0.95
            context.fillStyle = particle.color
            context.shadowColor = particle.color
            context.shadowBlur = 8 + particle.size * 2
            context.beginPath()
            context.arc(particle.x, particle.y, particle.size, 0, TAU)
            context.fill()
            context.restore()
          } else if (particle.shape === 'streak') {
            context.strokeStyle = particle.color
            context.lineWidth = Math.max(1, particle.size * 0.75)
            context.lineCap = 'round'
            context.beginPath()
            context.moveTo(particle.x, particle.y)
            context.lineTo(particle.x - particle.vx * 0.018, particle.y - particle.vy * 0.018)
            context.stroke()
          } else {
            context.save()
            context.translate(particle.x, particle.y)
            context.rotate(particle.angle)
            const size = particle.size * (1 - progress * 0.45)
            context.globalAlpha = Math.pow(1 - progress, 1.35) * 0.2
            context.fillRect(-size, -size, size * 2, size * 2)
            context.globalAlpha = Math.pow(1 - progress, 1.35)
            context.fillRect(-size / 2, -size / 2, size, size)
            context.restore()
          }
        }

        for (const ghostEntry of ghosts) {
          const progress = clamp(ghostEntry.age / ghostEntry.life, 0, 1)
          const snap = easeOutCubic(progress)
          context.save()
          context.globalAlpha = (1 - progress) * 0.18
          context.translate(ghostEntry.x, ghostEntry.y - 7 - progress * 13)
          context.rotate(ghostEntry.rotation * (1 - snap))
          const scale = 1.6 + Math.min(0.2, ghostEntry.power * 0.08) - 0.4 * snap
          context.scale(scale, scale)
          context.font = `${ghostEntry.weight} ${ghostEntry.size}px ${ghostEntry.family}`
          context.textAlign = 'left'
          context.textBaseline = 'alphabetic'
          context.shadowColor = ghostEntry.color
          context.shadowBlur = 14 * (1 - progress)
          context.fillStyle = palette.dark ? '#ffffff' : ghostEntry.color
          context.fillText(ghostEntry.char, 0, 0)
          context.globalAlpha = (1 - progress) * 0.92
          context.strokeStyle = ghostEntry.color
          context.lineWidth = 1.35
          context.strokeText(ghostEntry.char, 0, 0)
          context.restore()
        }

        drawHeat(now)
        drawCombo(now)
        context.globalAlpha = 1
        context.shadowBlur = 0
      }

      /** Draw the streak counter above the composer's top-right corner. */
      function drawCombo(now) {
        if (combo < 2 || lastEditor === null || !lastEditor.isConnected) return
        const remaining = comboExpiresAt - now
        if (remaining < -COMBO_FADE_MS) return
        const card = lastEditor.closest('[data-composer-card]') ?? lastEditor
        const cardRect = card.getBoundingClientRect()
        const canvasRect = canvas.getBoundingClientRect()
        if (cardRect.bottom < canvasRect.top || cardRect.top > canvasRect.bottom) return

        const alpha = clamp((remaining + COMBO_FADE_MS) / COMBO_FADE_MS, 0, 1)
        const scale = 1 + Math.min(1, combo / 90) * 0.26 + comboPop * 0.24
        const accent = combo >= 20 ? palette.hot : combo >= 8 ? palette.warm : palette.accent
        const font = `700 ${Math.round(13 * scale)}px ui-monospace, SFMono-Regular, Menlo, monospace`
        const text = `×${combo}`
        const pad = 9
        const pillHeight = 22 * scale
        const x = cardRect.right - canvasRect.left - 14
        const y = cardRect.top - canvasRect.top - 12

        context.save()
        context.globalAlpha = alpha * (reducedMotion ? 0.8 : 0.96)
        context.font = font
        context.textAlign = 'right'
        context.textBaseline = 'middle'
        const textWidth = context.measureText(text).width
        const pillWidth = textWidth + pad * 2 + 15
        const left = x - pillWidth
        const top = y - pillHeight

        roundedRect(context, left, top, pillWidth, pillHeight, pillHeight / 2)
        context.fillStyle = palette.pill
        context.fill()
        context.strokeStyle = palette.stroke
        context.lineWidth = 1
        context.stroke()

        drawBolt(context, left + pad + 4, top + pillHeight / 2, 6.4 * scale, accent)
        context.fillStyle = palette.text
        context.fillText(text, x - pad, top + pillHeight / 2 + 0.5)

        const progress = clamp(remaining / IDLE_RESET_MS, 0, 1)
        if (progress > 0) {
          context.globalAlpha = alpha * 0.9
          context.fillStyle = accent
          roundedRect(context, left + pad, top + pillHeight - 2.6, (pillWidth - pad * 2) * progress, 1.6, 1)
          context.fill()
        }
        context.restore()
      }

      const textOf = (editor) => editor.value ?? editor.textContent ?? ''

      function inputData(event) {
        const type = event.inputType || ''
        if (type.startsWith('delete') || type === 'insertCompositionText') return null
        return typeof event.data === 'string' && event.data.length > 0 ? event.data : null
      }

      function isCommittedInput(editor, data) {
        return committedInput?.editor === editor && committedInput.data === data
          && committedInput.text === textOf(editor)
      }

      function cancelPendingInput(editor) {
        const pending = pendingInputs.get(editor)
        if (pending === undefined) return
        win.clearTimeout(pending.timer)
        pendingInputs.delete(editor)
      }

      /** A prevented beforeinput may still commit through Lexical's microtask. */
      function flushInput(editor) {
        if (!syncEditor(editor)) return
        const pending = pendingInputs.get(editor)
        if (pending === undefined) return
        cancelPendingInput(editor)
        if (pending.event.defaultPrevented && textOf(editor) !== pending.before
          && !isCommittedInput(editor, pending.data)) {
          committedInput = null
          hit(editor, pending.data, 'type')
        }
      }

      /** Wait for the editor's final DOM reconciliation, then count one commit. */
      function finishComposition() {
        const pending = composition
        if (pending === null || pending.active) return
        if (!syncEditor(pending.editor)) return
        win.clearTimeout(pending.timer)
        composition = null
        const text = textOf(pending.editor)
        if (pending.data.length === 0 || text === pending.before) return
        committedInput = { editor: pending.editor, data: pending.data, text }
        hit(pending.editor, pending.data, 'type')
      }

      function clearPendingInputs() {
        for (const editor of pendingInputs.keys()) cancelPendingInput(editor)
        if (composition !== null) win.clearTimeout(composition.timer)
        composition = null
        committedInput = null
        compositionEndedAt = -Infinity
      }

      function onBeforeInput(event) {
        if (!enabled || disposed || event.isComposing) return
        const editor = editorOf(win, event.target)
        if (editor === null) return
        syncEditor(editor)
        if (composition?.editor === editor && composition.active) return
        if (committedInput?.editor === editor && committedInput.text !== textOf(editor)) committedInput = null
        const data = inputData(event)
        if (data === null) return
        // The final beforeinput can follow compositionend but precede the committed DOM.
        if (composition?.editor === editor && composition.data === data) return
        finishComposition()
        flushInput(editor)
        const pending = { before: textOf(editor), data, event, timer: 0 }
        // A task runs after both native editing and Lexical's queued DOM commit.
        pending.timer = win.setTimeout(() => flushInput(editor), 0)
        pendingInputs.set(editor, pending)
      }

      function onInput(event) {
        if (!enabled || disposed || event.isComposing) return
        const editor = editorOf(win, event.target)
        if (editor === null) return
        syncEditor(editor)
        if (composition?.editor === editor) return
        if (committedInput?.editor === editor && committedInput.text !== textOf(editor)) committedInput = null
        const data = inputData(event)
        if (data === null) {
          if (textOf(editor).trim().length > 0) lineRect = currentLineRect(editor)
          return
        }
        cancelPendingInput(editor)
        // Firefox can send the final input after compositionend, even in a later task.
        if (isCommittedInput(editor, data)) return
        committedInput = null
        hit(editor, data, 'type')
      }

      function onKeyDown(event) {
        if (!enabled || disposed || event.isComposing || event.keyCode === 229) return
        const editor = editorOf(win, event.target)
        if (editor === null) return
        syncEditor(editor)
        if (composition?.editor === editor && composition.active) return
        if (event.key !== 'Enter') {
          if (event.key === ' ' && clock() - compositionEndedAt < 10) return
          finishComposition()
          return
        }
        // Safari may deliver the candidate-confirming Enter just after compositionend.
        if (composition?.editor === editor || clock() - compositionEndedAt < 10) return
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
        hit(editor, '\n', 'submit')
      }

      function onFocusIn(event) {
        const editor = editorOf(win, event.target)
        if (editor === null) return
        syncEditor(editor)
      }

      function onCompositionStart(event) {
        if (!enabled || disposed) return
        const editor = editorOf(win, event.target)
        if (editor === null) return
        syncEditor(editor)
        finishComposition()
        flushInput(editor)
        committedInput = null
        composition = { editor, before: textOf(editor), active: true, data: '', timer: 0 }
      }

      function onCompositionEnd(event) {
        const editor = editorOf(win, event.target)
        if (editor === null) return
        syncEditor(editor)
        if (composition === null || composition.editor !== editor || !composition.active) return
        composition.active = false
        composition.data = event.data || ''
        compositionEndedAt = clock()
        composition.timer = win.setTimeout(finishComposition, 0)
      }

      function onWindowBlur() {
        clearPendingInputs()
        resetCombo()
        audio.suspend()
      }

      function onWindowFocus() {
        if (enabled && soundEnabled) audio.resume()
      }

      function onVisibilityChange() {
        if (doc.visibilityState === 'hidden') {
          resetCombo()
          audio.suspend()
        } else if (enabled && soundEnabled) {
          audio.resume()
        }
      }

      function onMotionPreference(event) {
        reducedMotion = event.matches
      }

      doc.addEventListener('beforeinput', onBeforeInput, true)
      doc.addEventListener('input', onInput, true)
      doc.addEventListener('keydown', onKeyDown, true)
      doc.addEventListener('focusin', onFocusIn, true)
      doc.addEventListener('compositionstart', onCompositionStart, true)
      doc.addEventListener('compositionend', onCompositionEnd, true)
      doc.addEventListener('visibilitychange', onVisibilityChange, true)
      win.addEventListener('blur', onWindowBlur)
      win.addEventListener('focus', onWindowFocus)
      win.addEventListener('resize', resize)
      motionQuery.addEventListener?.('change', onMotionPreference)

      if (typeof win.MutationObserver === 'function') {
        sessionObserver = new win.MutationObserver(() => {
          if (editorScope !== null) syncEditor(editorScope.editor)
        })
      }

      let observer = null
      if (typeof win.ResizeObserver === 'function') {
        observer = new win.ResizeObserver(() => resize())
        observer.observe(canvas.parentElement ?? canvas)
      }
      resize()

      api = {
        get enabled() {
          return enabled
        },
        get combo() {
          return combo
        },
        get heat() {
          return heat
        },
        get soundEnabled() {
          return soundEnabled
        },
        setEnabled(next) {
          enabled = Boolean(next)
          try {
            win.localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0')
          } catch {
            // Storage may be disabled; the current page still honors the toggle.
          }
          if (!enabled) {
            resetEffects()
            audio.setEnabled(false)
          } else {
            audio.setEnabled(soundEnabled)
          }
          return enabled
        },
        setIntensity(next) {
          const value = Number(next)
          intensity = Number.isFinite(value) ? clamp(value, 0.2, 2.5) : 1
          try {
            win.localStorage.setItem(INTENSITY_KEY, String(intensity))
          } catch {
            // Same as above: runtime-only when storage is unavailable.
          }
          return intensity
        },
        setSoundEnabled(next) {
          soundEnabled = Boolean(next)
          audio.setEnabled(soundEnabled)
          if (soundEnabled && enabled) audio.resume()
          try {
            win.localStorage.setItem(SOUND_KEY, soundEnabled ? '1' : '0')
          } catch {
            // Sound preference is still honored for this page.
          }
          return soundEnabled
        },
        setVolume(next) {
          const value = Number(next)
          if (Number.isFinite(value)) volume = clamp(value, 0, 1)
          audio.setEnabled(soundEnabled)
          audio.setVolume(volume)
          try {
            win.localStorage.setItem(VOLUME_KEY, String(volume))
          } catch {
            // Same as above.
          }
          return volume
        },
        burst() {
          if (!enabled || disposed) return false
          const editor = lastEditor !== null && lastEditor.isConnected
            ? lastEditor
            : doc.querySelector('[data-composer-input]')
          if (editor === null) return false
          hit(editor, '⚡', 'submit', false)
          return true
        },
        stats() {
          return {
            enabled,
            intensity,
            combo,
            heat: Number(heat.toFixed(3)),
            particles: particles.length,
            waves: waves.length,
            ghosts: ghosts.length,
            strikes: strikes.length,
            ghost: ghosts[0] === undefined ? null : {
              char: ghosts[0].char,
              x: Math.round(ghosts[0].x),
              y: Math.round(ghosts[0].y),
              age: Number(ghosts[0].age.toFixed(3)),
            },
            sound: {
              ...audio.stats(),
              enabled: soundEnabled && enabled,
              preference: soundEnabled,
              volume,
            },
          }
        },
        dispose() {
          if (disposed) return
          disposed = true
          resetEffects()
          audio.dispose()
          sessionObserver?.disconnect()
          sessionObserver = null
          editorScope = null
          lastEditor = null
          doc.removeEventListener('beforeinput', onBeforeInput, true)
          doc.removeEventListener('input', onInput, true)
          doc.removeEventListener('keydown', onKeyDown, true)
          doc.removeEventListener('focusin', onFocusIn, true)
          doc.removeEventListener('compositionstart', onCompositionStart, true)
          doc.removeEventListener('compositionend', onCompositionEnd, true)
          doc.removeEventListener('visibilitychange', onVisibilityChange, true)
          win.removeEventListener('blur', onWindowBlur)
          win.removeEventListener('focus', onWindowFocus)
          win.removeEventListener('resize', resize)
          motionQuery.removeEventListener?.('change', onMotionPreference)
          observer?.disconnect()
          observer = null
          if (win.__dshPowerType === api) {
            try {
              delete win.__dshPowerType
            } catch {
              win.__dshPowerType = undefined
            }
          }
        },
      }

      win.__dshPowerType = api
      return api
    }

    let engine = null

    /** React ref callback: one engine per mounted overlay canvas. */
    function attachCanvas(node) {
      if (node === null) {
        engine?.dispose()
        engine = null
        return
      }
      engine?.dispose()
      engine = createEngine(node)
    }

    /** The transparent overlay canvas; all visuals are drawn imperatively. */
    function PowerTypeLayer() {
      return React.createElement('canvas', {
        ref: attachCanvas,
        'data-dsh-power-type': 'canvas',
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          inset: 0,
          display: 'block',
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        },
      })
    }

    return {
      name: PLUGIN_ID,
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'power-type',
          order: -100,
        }, PowerTypeLayer))
      },
    }
  },
});
