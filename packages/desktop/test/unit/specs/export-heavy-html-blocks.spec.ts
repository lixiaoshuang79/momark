import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MuyaCore from '@muyajs/core'

// 大体积 HTML 块（编辑器里只显示降级卡片、没有沙箱帧）在导出里的处理：
// 不能再让它打乱「帧 ↔ 含脚本源码」的一一对应，否则同文档里的轻量图表块会因
// 数量对不上被整篇原样导出（导出物里一片空白或露出源码）。

const targets = vi.hoisted(() => [
  {
    html: '<div id="chart"><script>1</script></div>',
    width: 320,
    height: 200,
    zoom: 1,
    auto: false
  }
])
const frameTargets = vi.hoisted(() => ({ list: [] as typeof targets }))

vi.mock('@muyajs/core', async (importOriginal) => ({
  ...(await importOriginal<typeof MuyaCore>()),
  collectHtmlFrameTargets: () => frameTargets.list
}))
vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { inlineFramedHtmlBlocks } = await import('@/util/exportHtmlBlocks')

const payload = 'A'.repeat(300 * 1024)
const HEAVY = `<div id="proto"><script>var s="${payload}"</script></div>`
const HEAVY_STATIC = `<div><img src="data:image/png;base64,${payload}"></div>`
const muya = { domNode: document.createElement('div') } as never

beforeEach(() => {
  frameTargets.list = targets
  ;(window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { invoke: async () => ({ dataUrl: 'data:image/png;base64,SNAP' }) }
  }
})

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron
})

describe('inlineFramedHtmlBlocks — heavy blocks', () => {
  const markdown = `# 标题\n\n${targets[0].html}\n\n正文\n\n${HEAVY}\n\n尾段\n`

  it('image export: light chart is snapshotted, heavy block becomes a short note', async () => {
    const out = await inlineFramedHtmlBlocks(muya, markdown)
    expect(out.markdown).toContain('base64,SNAP')
    expect(out.markdown).not.toContain(payload)
    expect(out.markdown).not.toContain('<script>')
    expect(out.markdown).toMatch(/KB|MB/)
    for (const text of ['# 标题', '正文', '尾段']) expect(out.markdown).toContain(text)
  })

  it('live HTML export keeps both blocks as sandboxed frames in document order', async () => {
    const out = await inlineFramedHtmlBlocks(muya, markdown, { live: true })
    expect(out.frames).toHaveLength(2)
    expect(out.frames[0]).toContain('id=&quot;chart&quot;')
    expect(out.frames[1]).toContain('id=&quot;proto&quot;')
    expect(out.frames[1]).toContain('sandbox="allow-scripts')
    expect(out.markdown).toContain('momark-export-frame-0')
    expect(out.markdown).toContain('momark-export-frame-1')
  })

  it('a heavy block alone (no frames in the editor) is still handled', async () => {
    frameTargets.list = []
    const out = await inlineFramedHtmlBlocks(muya, `前\n\n${HEAVY}\n\n后\n`)
    expect(out.markdown).not.toContain(payload)
    expect(out.markdown).toContain('前')
    expect(out.markdown).toContain('后')
  })

  it('heavy blocks without scripts export unchanged (static HTML, same as before)', async () => {
    frameTargets.list = []
    const md = `前\n\n${HEAVY_STATIC}\n\n后\n`
    const out = await inlineFramedHtmlBlocks(muya, md)
    expect(out.markdown).toBe(md)
  })
})
