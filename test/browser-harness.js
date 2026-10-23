import { $createParagraphNode, $getRoot, createEditor } from 'lexical'
import { registerPlainText } from '@lexical/plain-text'

const editorElement = document.querySelector('[data-composer-input]')
const editor = createEditor({
  namespace: 'power-type-browser-regression',
  onError(error) { throw error },
})
editor.setRootElement(editorElement)
registerPlainText(editor)
editor.update(() => {
  $getRoot().append($createParagraphNode())
  $getRoot().selectEnd()
}, { discrete: true })

const events = []
for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
  document.addEventListener(type, (event) => {
    events.push({ type, data: event.data, inputType: event.inputType, isComposing: event.isComposing })
  }, true)
}

let layer = null
window.__powerTypeModule.apply({
  slots: {
    inject(name, contribute) {
      if (name !== 'shell.overlay') throw new Error(`Unexpected slot: ${name}`)
      return contribute()
    },
    register(options, component) {
      if (options.id !== 'power-type') throw new Error(`Unexpected layer: ${options.id}`)
      layer = component()
      return () => layer.props.ref(null)
    },
  },
})
const canvas = document.createElement(layer.type)
Object.assign(canvas.style, layer.props.style)
document.querySelector('[data-shell-overlay]').append(canvas)
layer.props.ref(canvas)

window.__powerTest = {
  editor: editorElement,
  events,
  snapshot() {
    return { text: editorElement.textContent, stats: window.__dshPowerType.stats(), events }
  },
}
window.__powerTestReady = true
