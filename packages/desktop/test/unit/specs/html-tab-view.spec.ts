import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import ts from 'typescript'
import { computed, defineComponent, nextTick, reactive, ref, shallowReactive, watch } from 'vue'

// 回归：html 标签视图在换标签、重新载入时必须重建 iframe。
//
// 所有 html 标签用的是同一个引导页 src（html-frame.html），iframe 不重建就不会有
// 新的 load，源码也就不会再投递；而引导页收到过源码后拒绝二次投递。老的右栏
// 单页实现因此停在上一份 HTML 上（用户实测）。
//
// 桌面单测运行器没有 @vitejs/plugin-vue / @vue/test-utils，这里直接编译真实 SFC
// 的 <script setup>，注入依赖后跑 setup()，并钉住模板真的把 key 绑给了 iframe。

const here = dirname(fileURLToPath(import.meta.url))
const vuePath = resolve(here, '../../../src/renderer/src/components/htmlTab/HtmlTabView.vue')

interface Bindings {
  frameKey: { value: string }
  turboMode: { value: boolean }
  pathname: { value: string }
}

const readSfc = () => parse(readFileSync(vuePath, 'utf8')).descriptor

const loadSetup = (deps: Record<string, unknown>) => {
  const compiled = compileScript(readSfc(), { id: 'test' })
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
    `const { _defineComponent, computed, nextTick, onBeforeUnmount, onMounted, ref, watch,
      useEditorStore, useHtmlTabsStore, usePreferencesStore, t } = __deps
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

const mount = () => {
  const sources = shallowReactive(new Map<string, { html: string; revision: number }>())
  const tabs = [
    { id: 'h1', pathname: '/p/a.html', filename: 'a.html' },
    { id: 'h2', pathname: '', filename: 'Demo' }
  ]
  const preferences = reactive({ turboMode: false })
  const props = reactive({ tabId: 'h1' })
  const comp = loadSetup({
    _defineComponent: defineComponent,
    computed,
    nextTick,
    onBeforeUnmount: () => {},
    onMounted: () => {},
    ref,
    watch,
    useEditorStore: () => ({ tabs }),
    useHtmlTabsStore: () => ({ sources, RELOAD: () => {} }),
    usePreferencesStore: () => preferences,
    t: (k: string) => k
  })
  const ret = comp.setup(props, { expose: () => {} })
  return { ret, props, sources, preferences }
}

describe('HtmlTabView', () => {
  it('换标签或重新载入都换一个新的 frame key（iframe 重建 → load → 重新投递源码）', async () => {
    const { ret, props, sources } = mount()
    sources.set('h1', { html: '<p>a</p>', revision: 1 })
    sources.set('h2', { html: '<p>b</p>', revision: 2 })
    const first = ret.frameKey.value

    props.tabId = 'h2'
    await nextTick()
    const second = ret.frameKey.value
    expect(second).not.toBe(first)

    sources.set('h2', { html: '<p>b2</p>', revision: 3 })
    await nextTick()
    expect(ret.frameKey.value).not.toBe(second)
  })

  it('路径只来自本标签：快照标签没有文件操作', async () => {
    const { ret, props } = mount()
    expect(ret.pathname.value).toBe('/p/a.html')
    props.tabId = 'h2'
    await nextTick()
    expect(ret.pathname.value).toBe('')
  })

  it('跟随极速模式开关', async () => {
    const { ret, preferences } = mount()
    expect(ret.turboMode.value).toBe(false)
    preferences.turboMode = true
    expect(ret.turboMode.value).toBe(true)
  })

  it('模板把 key 绑在 sandbox="allow-scripts" 的 iframe 上，极速模式不建帧', () => {
    const descriptor = readSfc()
    const template = descriptor.template?.content ?? ''
    const { code } = compileTemplate({ source: template, filename: vuePath, id: 'test' })

    expect(code).toMatch(/key:\s*(?:_ctx\.)?frameKey/)
    expect(template).toMatch(/<iframe[^>]*sandbox="allow-scripts"/)
    expect(template).not.toMatch(/allow-same-origin/)
    expect(template.indexOf('v-if="turboMode"')).toBeLessThan(template.indexOf('<iframe'))
  })
})
