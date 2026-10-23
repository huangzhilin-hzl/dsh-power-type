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
    const TAU = Math.PI * 2
    const IDLE_RESET_MS = 1600
    const COMBO_FADE_MS = 420
    const MAX_PARTICLES = 520

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

      const particles = []
      const waves = []
      const ghosts = []
      const strikes = []
      const pendingInputs = new Map()
      const animations = new Set()

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
          trackAnimation(editor.animate([
            { textShadow: '0 0 0 transparent' },
            { textShadow: `0 0 ${blur * amount}px ${color}, 0 0 1px ${color}`, offset: 0.18 },
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
      function hit(editor, data, kind) {
        if (!enabled || disposed || !editor.isConnected) return
        syncEditor(editor)
        const now = clock()
        refreshPalette(now)
        const point = pointOf(caretOf(win, editor))
        if (point === null) return
        lastEditor = editor

        if (kind === 'type') {
          if (now > comboExpiresAt) combo = 0
          combo += 1
          comboExpiresAt = now + IDLE_RESET_MS
          comboPop = 1
        } else {
          comboExpiresAt = Math.max(comboExpiresAt, now + 1200)
          comboPop = 1
        }

        const strength = kind === 'submit' ? 2 : clamp(0.7 + combo * 0.012, 0.7, 1.5)
        const accent = combo >= 50 ? palette.hot : combo >= 25 ? palette.warm : palette.accent
        const chars = Array.from(data)
        const visible = chars.filter((char) => char.trim().length > 0).at(-1) ?? ''

        if (kind === 'submit') {
          ring(point, 88, palette.hot, 3.2, 0.52)
          ring(point, 50, palette.warm, 2, 0.4)
          spawn(point, 34 + Math.min(28, combo * 0.5), {
            power: 1.7,
            spread: 1.2,
            colors: [palette.hot, palette.warm, palette.accent2],
          })
          strike(point, palette.hot, 2.6)
          shake(editor, 2.4, true)
          glow(editor, palette.hot, 22, 340)
        } else {
          if (combo % 3 === 0) ring(point, 18 + strength * 12, accent, 1 + strength * 0.5, 0.28)
          spawn(point, 8 + Math.min(8, combo * 0.1), {
            power: strength,
            spread: 0.9,
            colors: [accent, palette.accent2, palette.warm, palette.cool],
          })
          if (visible.length > 0) ghost(point, visible, editor, accent, strength)
          strike(point, accent, strength)
          shake(editor, strength, false)
          glow(editor, accent, 8 + strength * 8, 210)
          if (combo > 0 && combo % 25 === 0) {
            ring(point, 88, palette.warm, 2.4, 0.55)
            strike(point, palette.warm, 2.8)
            spawn(point, 26, {
              power: 1.8,
              spread: 1.3,
              colors: [palette.warm, palette.hot, palette.accent2],
            })
            shake(editor, 2.2, false)
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
          if (particle.shape === 'streak') {
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
        const accent = combo >= 50 ? palette.hot : combo >= 25 ? palette.warm : palette.accent
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
        if (data === null) return
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
      }

      function onVisibilityChange() {
        if (doc.visibilityState === 'hidden') resetCombo()
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
        setEnabled(next) {
          enabled = Boolean(next)
          try {
            win.localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0')
          } catch {
            // Storage may be disabled; the current page still honors the toggle.
          }
          if (!enabled) {
            resetEffects()
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
        burst() {
          if (!enabled || disposed) return false
          const editor = lastEditor !== null && lastEditor.isConnected
            ? lastEditor
            : doc.querySelector('[data-composer-input]')
          if (editor === null) return false
          hit(editor, '⚡', 'submit')
          return true
        },
        stats() {
          return {
            enabled,
            intensity,
            combo,
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
          }
        },
        dispose() {
          if (disposed) return
          disposed = true
          resetEffects()
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
