import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parse, compileScript } from 'vue/compiler-sfc'
import ts from 'typescript'
import { ref } from 'vue'

// P2（同区域）：源码模式的提交原来挂在 CodeMirror 的 `cursorActivity` 上**同步**
// 做——纯光标移动（点击/方向键）也会整篇 `getValue()` + 重算字数 + 走一遍 store
// 的内容变更管线；`commitTimer` 声明了却从没排过定时器，防抖形同虚设。
//
// 这里驱动的是真实 SFC 源码（编译后跑 setup，再用注入的假 CodeMirror 触发事件），
// 断言的是**行为与调用次数**：
//   - 一串光标活动只提交一次（防抖）；
//   - 纯光标移动不读全文、不重算字数；
//   - 内容变更后只读一次全文；
//   - `flush-active-editor`（保存/关标签/关窗前的同步补交）立即提交并取消防抖。
//
// 驱动方式与 `source-code-image-action.spec.ts` 相同：这个 runner 没有
// @vitejs/plugin-vue 与 @vue/test-utils，所以把 SFC 编译出来的 setup 用注入依赖
// 跑起来，拿闭包里的行为，每次运行都重读源码，不会漂移。

const here = dirname(fileURLToPath(import.meta.url))
const vuePath = resolve(here, '../../../src/renderer/src/components/editorWithTabs/sourceCode.vue')

interface CMCursor {
  line: number
  ch: number
}

interface SetupBindings {
  editor: { value: unknown }
  listenChange: () => void
}

interface SetupModule {
  default: { setup: (props: unknown, ctx: { expose: () => void }) => SetupBindings }
}

const loadComponent = (deps: Record<string, unknown>) => {
  const src = readFileSync(vuePath, 'utf8')
  const { descriptor } = parse(src)
  const compiled = compileScript(descriptor, { id: 'test' })
  // Drop every import; bindings come from the injected `__deps` object so the
  // store/codeMirror/muya/config modules never load.
  const noImports = compiled.content
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l))
    .join('\n')
  // esbuild's transformSync trips over jsdom's TextEncoder realm, so transpile
  // the TS away with the (pure-JS) typescript compiler.
  const js = ts.transpileModule(noImports, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    '__deps',
    'exports',
    'module',
    `const { _defineComponent, ref, markRaw, watch, onMounted, onBeforeUnmount, nextTick,
      useEditorStore, usePreferencesStore, storeToRefs, codeMirror,
      setCursorAtFirstLine, setTextDirection, getWordCount, adjustCursor, bus,
      oneDarkThemes, railscastsThemes } = __deps
    ${js}
    return module.exports`
  ) as (deps: Record<string, unknown>, exports: object, module: object) => SetupModule
  const m = { exports: {} as Record<string, unknown> }
  const exported = factory(deps, m.exports, m)
  return exported.default
}

type EventHandler = (payload?: unknown) => void

interface StubCM {
  on: (event: string, handler: EventHandler) => void
  emit: (event: string) => void
  getValue: ReturnType<typeof vi.fn>
  setDocValue: (v: string) => void
  getCursor: (which: string) => CMCursor
  getLine: (n: number) => string
  lineCount: () => number
  setOption: ReturnType<typeof vi.fn>
  setSelection: ReturnType<typeof vi.fn>
  getScrollerElement: () => null
  hasFocus: () => boolean
  execCommand: ReturnType<typeof vi.fn>
}

const makeCM = (value: string): StubCM => {
  let current = value
  const handlers = new Map<string, EventHandler[]>()
  const cm: StubCM = {
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    emit: (event) => {
      for (const handler of handlers.get(event) ?? []) handler()
    },
    // 计数读数：整篇读取是这条路径上最贵的一步，用调用次数钉住「什么时候才读」。
    getValue: vi.fn(() => current),
    setDocValue: (v: string) => {
      current = v
    },
    getCursor: () => ({ line: 0, ch: 0 }),
    getLine: () => '',
    lineCount: () => 1,
    setOption: vi.fn(),
    setSelection: vi.fn(),
    getScrollerElement: () => null,
    hasFocus: () => true,
    execCommand: vi.fn()
  }
  return cm
}

const makeDeps = (cm: StubCM) => {
  const listenSpy = vi.fn()
  const wordCountSpy = vi.fn(() => ({ word: 2, paragraph: 1, character: 11, all: 11 }))
  const mounted: Array<() => void> = []
  const unmounted: Array<() => void> = []
  const busHandlers = new Map<string, EventHandler[]>()
  const busEmits: Array<{ event: string; payload: unknown }> = []
  const bus = {
    on: (event: string, handler: EventHandler) => {
      const list = busHandlers.get(event) ?? []
      list.push(handler)
      busHandlers.set(event, list)
    },
    off: (event: string, handler: EventHandler) => {
      busHandlers.set(
        event,
        (busHandlers.get(event) ?? []).filter((h) => h !== handler)
      )
    },
    emit: (event: string, payload?: unknown) => {
      busEmits.push({ event, payload })
      for (const handler of [...(busHandlers.get(event) ?? [])]) handler(payload)
    }
  }
  const deps = {
    _defineComponent: (o: unknown) => o,
    ref,
    markRaw: (o: unknown) => o,
    watch: () => {},
    onMounted: (cb: () => void) => mounted.push(cb),
    onBeforeUnmount: (cb: () => void) => unmounted.push(cb),
    nextTick: () => Promise.resolve(),
    useEditorStore: () => ({ LISTEN_FOR_CONTENT_CHANGE: listenSpy, listToc: [] }),
    usePreferencesStore: () => ({}),
    storeToRefs: () => ({
      theme: ref(''),
      sourceCode: ref(true),
      currentFile: ref({ id: 'tab-1' })
    }),
    codeMirror: () => cm,
    setCursorAtFirstLine: vi.fn(),
    setTextDirection: () => {},
    getWordCount: wordCountSpy,
    adjustCursor: (c: unknown) => c,
    bus,
    oneDarkThemes: [],
    railscastsThemes: [],
    __listenSpy: listenSpy,
    __wordCountSpy: wordCountSpy,
    __mounted: mounted,
    __unmounted: unmounted,
    __bus: bus,
    __busEmits: busEmits
  }
  return deps
}

const boot = (value = 'hello world') => {
  const cm = makeCM(value)
  const deps = makeDeps(cm)
  const comp = loadComponent(deps)
  comp.setup({ markdown: value, muyaIndexCursor: null, textDirection: 'ltr' }, { expose: () => {} })
  for (const cb of deps.__mounted) cb()
  return { cm, deps }
}

const listenCalls = (deps: ReturnType<typeof makeDeps>) => deps.__listenSpy.mock.calls

describe('sourceCode commit path — debounce + lightweight caret commits (P2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a burst of cursor activity into a single commit', () => {
    const { cm, deps } = boot()

    cm.emit('cursorActivity')
    cm.emit('cursorActivity')
    cm.emit('cursorActivity')
    expect(listenCalls(deps)).toHaveLength(0)

    vi.advanceTimersByTime(299)
    expect(listenCalls(deps)).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(listenCalls(deps)).toHaveLength(1)
  })

  it('a pure caret move commits the cursor WITHOUT reading the document or recounting words', () => {
    const { cm, deps } = boot('hello world')
    const readsAtMount = cm.getValue.mock.calls.length

    cm.emit('cursorActivity')
    vi.advanceTimersByTime(300)

    const calls = listenCalls(deps)
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toMatchObject({ id: 'tab-1', markdown: 'hello world' })
    // 关键：没有 `getValue()`（整篇读），也没有额外一次字数统计。
    expect(cm.getValue.mock.calls.length).toBe(readsAtMount)
    expect(deps.__wordCountSpy.mock.calls.length).toBe(1) // 只有 onMounted 的初始播种
  })

  it('reads the document exactly once per content change and reuses it for later caret moves', () => {
    const { cm, deps } = boot('hello world')
    const readsAtMount = cm.getValue.mock.calls.length

    cm.setDocValue('hello world!')
    cm.emit('change')
    cm.emit('cursorActivity')
    vi.advanceTimersByTime(300)

    expect(cm.getValue.mock.calls.length).toBe(readsAtMount + 1)
    expect(deps.__wordCountSpy.mock.calls.length).toBe(2) // 播种 + 这次内容变更
    expect(listenCalls(deps)[0]![0]).toMatchObject({ markdown: 'hello world!' })

    // 之后的纯光标移动：仍然不读全文。
    cm.emit('cursorActivity')
    vi.advanceTimersByTime(300)
    expect(cm.getValue.mock.calls.length).toBe(readsAtMount + 1)
    expect(listenCalls(deps)).toHaveLength(2)
  })

  it('flush-active-editor commits immediately (save/close cannot miss the debounce window)', () => {
    const { cm, deps } = boot('hello world')

    cm.setDocValue('typed but not committed')
    cm.emit('change')
    expect(listenCalls(deps)).toHaveLength(0)

    // 保存/关标签/关窗前 store 会发这个事件，必须同步补交。
    deps.__bus.emit('flush-active-editor')
    expect(listenCalls(deps)).toHaveLength(1)
    expect(listenCalls(deps)[0]![0]).toMatchObject({ markdown: 'typed but not committed' })

    // 防抖已被取消：不会再有第二次提交。
    vi.advanceTimersByTime(1000)
    expect(listenCalls(deps)).toHaveLength(1)
  })

  it('commits the live document on unmount and cancels the pending timer', () => {
    const { cm, deps } = boot('hello world')

    cm.setDocValue('last edit')
    cm.emit('change')
    for (const cb of deps.__unmounted) cb()

    // 卸载路径自己发 file-changed（带最新内容）给左编辑器，不经过防抖提交。
    const fileChanged = deps.__busEmits.filter((e) => e.event === 'file-changed')
    expect(fileChanged).toHaveLength(1)
    expect(fileChanged[0]!.payload).toMatchObject({ markdown: 'last edit' })

    // 挂起中的防抖提交被取消（viewDestroyed 之后不允许再写 store）。
    vi.advanceTimersByTime(1000)
    expect(listenCalls(deps)).toHaveLength(0)
  })
})
