import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// 打开本地 .html 做「md + html」左右对照评审：扩展名识别、另存为补 doctype、
// 预览用内联（保留 doctype 与空行）、html 标签源码 store 的载入 / 重新载入 / 丢弃。

vi.mock('@/store/layout', () => ({ useLayoutStore: () => ({ effectiveSideBarWidth: 0 }) }))
const notify = vi.hoisted(() => vi.fn())
vi.mock('@/services/notification', () => ({ default: { notify } }))

const ipc = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(() => () => {}),
  invoke: vi.fn()
}))
const files = vi.hoisted(() => new Map<string, string>())
vi.hoisted(() => {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.bp = { closePage: async () => {}, setInputContext: () => {} }
  w.window.electron = { ipcRenderer: ipc }
  w.window.fileUtils = {
    realpath: async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      return p
    },
    stat: async (p: string) => ({ isFile: true, size: (files.get(p) ?? '').length }),
    readFile: async (p: string, enc: string) =>
      enc === 'base64' ? Buffer.from(files.get(p) ?? '').toString('base64') : files.get(p)
  }
})

import { hasHtmlExtension, isChildOfDirectory } from 'common/filesystem/paths'
import { toStandaloneHtml } from 'common/html/standalone'
import { inlineHtmlDocument, inlineHtmlForPreview } from '@/util/htmlInline'
import { useHtmlTabsStore } from '@/store/htmlTabs'
;(window.fileUtils as unknown as Record<string, unknown>).isChildOfDirectory = isChildOfDirectory

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  files.clear()
})

describe('hasHtmlExtension', () => {
  it('accepts .html / .htm case-insensitively and nothing else', () => {
    expect(hasHtmlExtension('/a/proto.html')).toBe(true)
    expect(hasHtmlExtension('/a/PROTO.HTM')).toBe(true)
    expect(hasHtmlExtension('/a/prd.md')).toBe(false)
    expect(hasHtmlExtension('/a/html')).toBe(false)
    expect(hasHtmlExtension('/a/x.html.md')).toBe(false)
  })
})

describe('toStandaloneHtml（重量块另存为 .html）', () => {
  it('drops the momark-frame size marker and restores the doctype', () => {
    const out = toStandaloneHtml('<!--momark-frame w=800 h=600 z=1-->\n<html><body>x</body></html>')
    expect(out).toBe('<!DOCTYPE html>\n<html><body>x</body></html>')
  })

  it('keeps an existing doctype and never rewrites `$` sequences in the content', () => {
    const src = '<!doctype html><p>$$ $& $1</p>'
    expect(toStandaloneHtml(src)).toBe(src)
  })
})

describe('inlineHtmlForPreview（html 标签预览本地 .html）', () => {
  it('inlines same-folder CSS / JS / images and keeps doctype + blank lines', async () => {
    files.set('/p/app.css', 'body{color:red}')
    files.set('/p/app.js', 'window.x=1')
    files.set('/p/a.png', 'PNG')
    const raw =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="app.css"></head>' +
      '<body><pre>a\n\nb</pre><img src="a.png"><script src="app.js"></script></body></html>'
    const out = await inlineHtmlForPreview(raw, '/p/index.html')
    expect(out.html.startsWith('<!DOCTYPE html>\n')).toBe(true)
    expect(out.html).toContain('<style>body{color:red}</style>')
    expect(out.html).toContain('<script>window.x=1</script>')
    expect(out.html).toContain('src="data:image/png;base64,')
    expect(out.html).toContain('a\n\nb')
    expect(out.missed).toEqual([])
  })

  it('reports resources that cannot be read', async () => {
    const out = await inlineHtmlForPreview('<link rel="stylesheet" href="gone.css">', '/p/i.html')
    expect(out.missed).toEqual([{ path: '/p/gone.css', reason: 'missing' }])
  })

  it('leaves the .md embedding variant unchanged (no doctype, blank lines collapsed)', async () => {
    const out = await inlineHtmlDocument('<!DOCTYPE html><pre>a\n\nb</pre>', '/p/i.html')
    expect(out.html).not.toMatch(/<!doctype/i)
    expect(out.html).not.toMatch(/\n\s*\n/)
  })
})

describe('html tab sources', () => {
  const doc = { pathname: '/p/proto.html', filename: 'proto.html', html: '<p>hi</p>' }

  it('keeps the path and inlines same-folder resources for a file', async () => {
    files.set('/p/app.css', 'body{color:red}')
    const store = useHtmlTabsStore()
    await store.SET_SOURCE('h1', {
      ...doc,
      html: '<link rel="stylesheet" href="app.css"><p>hi</p>'
    })
    const source = store.sources.get('h1')
    expect(source?.pathname).toBe('/p/proto.html')
    expect(source?.html).toContain('body{color:red}')
    expect(source?.html).not.toContain('href="app.css"')
  })

  it('uses a block snapshot verbatim and remembers which document it came from', async () => {
    const store = useHtmlTabsStore()
    await store.SET_SOURCE(
      'h1',
      { pathname: '', filename: 'Demo', html: '<link href="x.css">' },
      'prd.md'
    )
    expect(store.sources.get('h1')).toMatchObject({
      html: '<link href="x.css">',
      pathname: '',
      origin: 'prd.md'
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('reports resources that were not inlined', async () => {
    const store = useHtmlTabsStore()
    await store.SET_SOURCE('h1', { ...doc, html: '<script src="gone.js"></script>' })
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('reload re-reads the file by its path and bumps the revision', async () => {
    const store = useHtmlTabsStore()
    await store.SET_SOURCE('h1', doc)
    const before = store.sources.get('h1')!.revision
    ipc.invoke.mockResolvedValueOnce({ ...doc, html: '<p>v2</p>' })
    await store.RELOAD('h1')
    expect(ipc.invoke).toHaveBeenCalledWith('mt::html::read', '/p/proto.html')
    expect(store.sources.get('h1')?.html).toContain('<p>v2</p>')
    expect(store.sources.get('h1')!.revision).toBeGreaterThan(before)
  })

  it('keeps the page when the file can no longer be read', async () => {
    const store = useHtmlTabsStore()
    await store.SET_SOURCE('h1', doc)
    ipc.invoke.mockResolvedValueOnce(null)
    await store.RELOAD('h1')
    expect(store.sources.get('h1')?.html).toContain('<p>hi</p>')
  })

  it('snapshots have nothing to reload', async () => {
    const store = useHtmlTabsStore()
    await store.SET_SOURCE('h1', { pathname: '', filename: 'Demo', html: '<p>x</p>' })
    await store.RELOAD('h1')
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it('the last of two overlapping loads wins, and a dropped tab is not resurrected', async () => {
    files.set('/p/slow.css', 'a{}')
    const store = useHtmlTabsStore()
    const first = store.SET_SOURCE('h1', {
      ...doc,
      html: '<link rel="stylesheet" href="slow.css">v1'
    })
    const second = store.SET_SOURCE('h1', { ...doc, html: 'v2' })
    await Promise.all([first, second])
    expect(store.sources.get('h1')?.html).toContain('v2')

    const third = store.SET_SOURCE('h2', doc)
    store.DROP('h2')
    await third
    expect(store.sources.has('h2')).toBe(false)
  })
})
