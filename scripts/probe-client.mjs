// Render smoke test for the client half without a browser: evaluate
// `client/client.js` against a tiny React stub, run `apply(ctx)`, then render
// the captured slot components and dump their text tree.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

let loaded
const window = {
  __ModuleLoader__: {
    load(mod) {
      loaded = mod
    },
  },
}
const noop = () => {}
const sandbox = {
  window,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'idle', cards: [] }) }),
  document: {
    head: { appendChild: noop },
    createElement: () => ({ setAttribute: noop, remove: noop, textContent: '' }),
    querySelector: () => null,
    body: {},
  },
  navigator: { clipboard: { writeText: async () => {} } },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })
if (!loaded) throw new Error('module loader was not called')
console.log('module id:', loaded.id)

// --- tiny React -------------------------------------------------------------
const hookStates = []
let hookIndex = 0
const resetHooks = () => {
  hookIndex = 0
  // States must be dropped too: a component rendered earlier left values at
  // the same indices, and `useState` would otherwise hand them to the next
  // component.
  hookStates.length = 0
}
const render = (element) => {
  if (element === null || element === undefined || element === false || element === true) return null
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(render)
  const { type, props, children } = element
  const kids = [props && props.children, children]
  const allProps = { ...(props || {}) }
  if (typeof type === 'function') {
    const inner = type({ ...allProps, children: flatten(kids) })
    return render(inner)
  }
  return { type, props: allProps, children: flatten(kids).map(render) }
}
const flatten = (value) => {
  const out = []
  for (const item of value) {
    if (item === undefined || item === null || item === false || item === true) continue
    if (Array.isArray(item)) out.push(...flatten(item))
    else out.push(item)
  }
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children || []).map(textOf).join(' ')
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    const index = hookIndex
    hookIndex += 1
    if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      hookStates[index] = typeof value === 'function' ? value(hookStates[index]) : value
    }
    return [hookStates[index], set]
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  useRef(value) {
    return { current: value }
  },
  Fragment: 'fragment',
}

const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
}

// --- fake host ctx ----------------------------------------------------------
const registrations = []
const services = new Map()
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : noop
  },
  inject(keys, callback) {
    const bag = { get: (name) => services.get(name) }
    return callback ? callback(bag) : undefined
  },
  get(name) {
    return services.get(name)
  },
  on: noop,
  provide: noop,
  slots: {
    inject(_name, callback) {
      return callback()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return noop
    },
  },
  locale: {
    register() {
      return noop
    },
    bind() {
      // Worst case observed in the real GUI: the namespace is not live yet and
      // the bound translator hands the key straight back. The plugin must then
      // fall back to its own dictionary instead of leaking `radar.title`.
      return (key) => key
    },
    getLocale() {
      return { active: 'zh-CN' }
    },
  },
}
services.set('sidebarRightTabs', {
  register(options) {
    registrations.push({ options, Component: null })
    return noop
  },
})

const module = loaded.factory(requireStub)
module.apply(ctx)

const tabReg = registrations.find((entry) => entry.Component === null)
console.log('tab id:', tabReg && tabReg.options.id, '| kind:', tabReg && tabReg.options.kind)
console.log('guide:', JSON.stringify((tabReg && tabReg.options.guide) || []).slice(0, 120))

const tabTitle = tabReg.options.title()
const guideEntry = (tabReg.options.guide || [])[0] || {}
const guideTitle = typeof guideEntry.title === 'function' ? guideEntry.title() : guideEntry.title
const guideDesc = typeof guideEntry.description === 'function' ? guideEntry.description() : guideEntry.description
console.log('tab title:', tabTitle, '| guide title:', guideTitle, '| guide desc:', guideDesc)
if (tabTitle !== 'GitHub 雷达') throw new Error(`tab title leaked a raw key: ${tabTitle}`)
if (guideTitle !== 'GitHub 雷达') throw new Error(`guide title leaked a raw key: ${guideTitle}`)
if (!guideDesc || guideDesc === 'radar.guide.description') throw new Error('guide description leaked a raw key')

const paneReg = registrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
const titleReg = registrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title')
console.log('pane key:', paneReg && paneReg.options.key, '| title key:', titleReg && titleReg.options.key)

resetHooks()
const injected = paneReg.options.inject ? paneReg.options.inject('session-1') : {}
const tree = render(React.createElement(paneReg.Component, { ...injected, t: (key) => key }))
const text = textOf(tree).replace(/\s+/g, ' ').trim()
console.log('pane text:', text.slice(0, 400))
console.log('pane render ok:', text.length > 0)

const components = module.__components || {}
const label = (key) => key

const card = {
  fullName: 'react-dropzone/react-dropzone',
  htmlUrl: 'https://github.com/react-dropzone/react-dropzone',
  descriptionEn: 'Simple HTML5 drag-drop zone with React',
  topics: ['react', 'upload'],
  language: 'JavaScript',
  stars: 10_500,
  pushedAt: new Date().toISOString(),
  archived: false,
  zh: '基于 HTML5 的 React 拖拽上传组件',
  zhSource: 'llm',
  why: '因为你在会话里提到「上传」',
  install: ['npm install react-dropzone'],
}
resetHooks()
const cardTree = render(
  React.createElement(components.RadarCard, {
    card,
    // Simulate a dead locale seat: the plugin must still render real labels.
    t: label,
    translate: injected.translate,
    onOpen: noop,
    onDismiss: noop,
    onCopy: noop,
  }),
)
const cardText = textOf(cardTree).replace(/\s+/g, ' ').trim()
console.log('card text:', cardText.slice(0, 300))
console.log('card has AI badge:', /AI/.test(JSON.stringify(cardTree)))
if (/radar\.(card|why|title)/.test(cardText)) throw new Error(`card leaked a raw key: ${cardText}`)
// The label comes from the built-in dictionary (the dead `t` seat falls back to
// it), so assert the rendered Chinese action rather than the raw key.
if (!cardText.includes('问问 AI')) throw new Error('card is missing the ask-ai action')

resetHooks()
const settingsTree = render(
  React.createElement(components.SettingsPanel, {
    t: label,
    translate: injected.translate,
    onClose: noop,
    initialDraft: {
      enableAiSummary: true,
      aiReady: true,
      hasToken: false,
      tokenInput: '',
      minStars: 30,
      maxCards: 5,
      languages: [],
      chineseOnly: false,
      allowNetwork: true,
      proxyUrl: '',
    },
  }),
)
const settingsText = textOf(settingsTree).replace(/\s+/g, ' ').trim()
console.log('settings text:', settingsText.slice(0, 260))
if (!settingsText || /setting\./.test(settingsText)) throw new Error(`settings leaked a raw key: ${settingsText}`)

// --- conversation draft bridge ---------------------------------------------
// The panel hands a repo to the model by filling the composer. That code path
// talks to host services that only exist in the browser, so exercise its three
// shapes here: plain draft, chip draft (span insert), and missing services.
const { appendToDraft, analysisPrompt, foldDraftOffset, appendOffsetOf } = module.__internals || {}
if (typeof appendToDraft !== 'function') throw new Error('appendToDraft is not exposed')

const prompt = analysisPrompt(card, 'zh')
if (!prompt.includes(card.fullName) || !prompt.includes(card.htmlUrl)) throw new Error('prompt lost the identity')
if (!prompt.includes('深度分析')) throw new Error('prompt is missing the analysis request')
if (/[{}]/.test(prompt)) throw new Error('prompt has broken braces')

// 1) no chips -> setDraft with a separating space
{
  const calls = []
  const snapshot = { draft: 'hello', occurrences: [], phase: 'idle', draftRev: 1 }
  const draftCtx = {
    get(name) {
      if (name === 'sessions') return { scope: () => ({ emit() {} }) }
      if (name === 'conversation')
        return {
          input: {
            for: () => ({
              state: { getSnapshot: () => snapshot },
              setDraft(value) {
                calls.push(value)
              },
            }),
          },
        }
      return undefined
    },
  }
  const ok = appendToDraft(draftCtx, 'session-1', 'TEXT')
  if (!ok) throw new Error('plain draft insert returned false')
  if (calls.length !== 1 || calls[0] !== 'hello TEXT') throw new Error(`unexpected setDraft: ${JSON.stringify(calls)}`)
}

// 2) chips present -> span insert at the folded offset
{
  const emitted = []
  const snapshot = {
    draft: 'see @file1 ',
    occurrences: [{ offset: 4, length: 6 }],
    phase: 'idle',
    draftRev: 7,
  }
  const draftCtx = {
    get(name) {
      if (name === 'sessions')
        return {
          scope: () => ({
            emit(event, payload) {
              emitted.push({ event, payload })
            },
          }),
        }
      if (name === 'conversation')
        return {
          input: {
            for: () => ({
              state: { getSnapshot: () => ({ ...snapshot, draftRev: emitted.length > 0 ? 8 : 7 }) },
              setDraft() {
                throw new Error('setDraft must not run when chips are present')
              },
            }),
          },
        }
      return undefined
    },
  }
  const ok = appendToDraft(draftCtx, 'session-1', 'TEXT')
  if (!ok) throw new Error('chip draft insert returned false')
  if (emitted.length !== 1 || emitted[0].event !== 'slash/input-insert-text') throw new Error('span channel was not used')
  const span = emitted[0].payload.span
  if (!span || span.start !== 6 || span.end !== 6 || span.draftRev !== 7)
    throw new Error(`unexpected span: ${JSON.stringify(span)}`)
  // The draft already ends with a space, so no separator is added.
  if (emitted[0].payload.text !== 'TEXT') throw new Error(`separator handling drifted: ${emitted[0].payload.text}`)
}

// 3) missing services degrade to false instead of throwing
{
  const brokenCtx = {
    get() {
      throw new Error('no services here')
    },
  }
  if (appendToDraft(brokenCtx, 'session-1', 'TEXT') !== false) throw new Error('broken ctx must return false')
}

const folded = foldDraftOffset('abc @ref', [{ offset: 4, length: 4 }], 8)
if (folded !== 5) throw new Error(`foldDraftOffset expected 5, got ${folded}`)
const appended = appendOffsetOf({ draft: 'abc @ref', occurrences: [{ offset: 4, length: 4 }], phase: 'idle' })
if (appended !== 5) throw new Error(`appendOffsetOf expected 5, got ${appended}`)
console.log('draft bridge ok: true')
