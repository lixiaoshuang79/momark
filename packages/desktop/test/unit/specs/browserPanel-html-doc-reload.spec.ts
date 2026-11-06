import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import ts from 'typescript'
import { ref, computed, watch, nextTick, defineComponent } from 'vue'

// 回归：右栏「HTML 渲染页」在换页时必须重建 iframe。
//
// 右栏与编辑器内嵌用的是同一个引导页 src（html-frame.html），iframe 不重建就
// 不会有新的 load，`deliverHtmlSource` 也就不会再投递；而引导页有 written 标志、
// 收到过源码后拒绝二次投递。老代码因此一直停在上一份 HTML——在另一个文件里点
// 「在侧栏打开」，看到的就是别的文件的页面（用户实测）。
//
// 桌面单测运行器没有 @vitejs/plugin-vue / @vue/test-utils（同 search-prefill
// 的先例），这里直接编译真实 SFC 的 <script setup>，注入依赖后跑 setup()，
// 断言「htmlDoc 换一次 → frameKey 加一次」，并钉住模板真的把这个 key 绑给了
// iframe——否则改了 key 却没生效。

const here = dirname(fileURLToPath(import.meta.url))
const vuePath = resolve(here, '../../../src/renderer/src/components/browserPanel/docMode.vue')

interface Bindings {
  htmlDoc: { value: { src: string; title: string; html?: string } | null }
  frameKey: { value: number }
}

const readSfc = () => parse(readFileSync(vuePath, 'utf8')).descriptor

const loadSetup = (deps: Record<string, unknown>) => {
  const descriptor = readSfc()
  const compiled = compileScript(descriptor, { id: 'test' })
  const noImports = compiled.content
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l))
    .join('\n')
  const js = ts.transpileModule(noImports, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    '__deps',
    'exports',
    'module',
    `const { _defineComponent, ref, computed, watch, nextTick, onMounted, onBeforeUnmount,
      useWorkspaceStore, useBrowserPanelStore, useEditorStore, useSplitStore, storeToRefs, t,
      DocEditorPane } = __deps
    // compileScript 把 <script setup> 里的 defineExpose 编译成自由标识符 __expose，
    // 正常由插件注入；这里手动兜一个。
    const __expose = () => {}
    ${js}
    return module.exports`
  ) as (
    d: Record<string, unknown>,
    exports: object,
    module: object
  ) => {
    default: { setup: (props: unknown, ctx: { expose: () => void }) => Bindings }
  }
  const m = { exports: {} as Record<string, unknown> }
  return factory(deps, m.exports, m).default
}

const makeBindings = () => {
  const htmlDoc = ref<Bindings['htmlDoc']['value']>(null)
  const splitDocTab = ref(null)

  // docMode 的 watch 里会 new ResizeObserver 贴缩放补偿；jsdom 不提供，兜一个空实现。
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never

  const deps = {
    _defineComponent: defineComponent,
    ref,
    computed,
    watch,
    nextTick,
    onMounted: () => {},
    onBeforeUnmount: () => {},
    useWorkspaceStore: () => ({ __store: 'workspace' }),
    useBrowserPanelStore: () => ({ __store: 'bp' }),
    useEditorStore: () => ({
      tabs: [],
      NEW_TAB_WITH_CONTENT: () => {},
      NEW_UNTITLED_TAB: () => {}
    }),
    useSplitStore: () => ({ active: false, tabId: '', DRAG_TO_SPLIT: () => {} }),
    storeToRefs: (store: { __store?: string }) =>
      store.__store === 'bp' ? { htmlDoc } : { splitDocTab },
    t: (k: string) => k,
    DocEditorPane: { name: 'DocEditorPane' }
  }

  const comp = loadSetup(deps)
  const ret = comp.setup({}, { expose: () => {} })

  return { ret, htmlDoc }
}

describe('browser panel html doc reload', () => {
  it('每次换 HTML 页都换一个新的 frame key（iframe 重建 → load → 重新投递源码）', async () => {
    const { ret, htmlDoc } = makeBindings()
    await nextTick()
    const start = ret.frameKey.value

    htmlDoc.value = { src: 'file:///app/html-frame.html', title: 'HTML', html: '<p>a</p>' }
    await nextTick()
    expect(ret.frameKey.value).toBe(start + 1)

    // 指向另一个块的同一引导页 src：src 不变，只有 key 能逼出重建。
    htmlDoc.value = { src: 'file:///app/html-frame.html', title: 'HTML', html: '<p>b</p>' }
    await nextTick()
    expect(ret.frameKey.value).toBe(start + 2)
  })

  it('模板把这个 key 绑在 iframe 上', () => {
    const descriptor = readSfc()
    const { code } = compileTemplate({
      source: descriptor.template?.content ?? '',
      filename: vuePath,
      id: 'test'
    })

    // 未提供 bindingMetadata 时，模板里的 setup 绑定编译成 `_ctx.frameKey`。
    expect(code).toMatch(/key:\s*(?:_ctx\.)?frameKey/)
  })
})
