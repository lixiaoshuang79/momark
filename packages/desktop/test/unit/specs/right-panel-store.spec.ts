import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.hoisted(() => {
  const w = globalThis as unknown as { window?: { path?: { sep: string } } }
  w.window ??= {}
  w.window.path ??= { sep: '/' }
})

vi.mock('@/store/bufferedState', () => ({ debouncedSendBufferedState: vi.fn() }))

import { useBrowserPanelStore } from '@/store/browserPanel'
import { useLayoutStore } from '@/store/layout'
import { usePreferencesStore } from '@/store/preferences'
import { useWorkspaceStore } from '@/store/workspace'
import bus from '@/bus'

const win = window as unknown as Record<string, unknown>
let seq = 0

describe('右侧栏 store（feat/right-panel-redesign）', () => {
  beforeEach(() => {
    seq = 0
    win.electron = {
      ipcRenderer: { on: vi.fn(), send: vi.fn(), invoke: vi.fn(() => Promise.resolve(null)) }
    }
    win.marktext = { env: { windowId: 1 } }
    win.bp = {
      createPage: vi.fn(async () => `p${++seq}`),
      closePage: vi.fn(),
      activate: vi.fn(),
      setDeviceMode: vi.fn(async () => true),
      setInputContext: vi.fn()
    }
    setActivePinia(createPinia())
  })
  afterEach(() => {
    bus.all?.clear?.()
    vi.clearAllMocks()
  })

  const open3 = async () => {
    const bp = useBrowserPanelStore()
    for (const u of ['a.com', 'b.com', 'c.com']) await bp.ADD_WEB_PAGE(u)
    return bp
  }

  it('关闭当前页激活右邻，没有右邻激活左邻；关闭非当前页不改当前页', async () => {
    const bp = await open3()
    bp.ACTIVATE_PAGE('p2')
    await bp.CLOSE_PAGE('p2')
    expect(bp.activePageId).toBe('p3')
    await bp.CLOSE_PAGE('p3')
    expect(bp.activePageId).toBe('p1')
    await bp.ADD_WEB_PAGE('d.com')
    await bp.CLOSE_PAGE('p1')
    expect(bp.activePageId).toBe('p4')
  })

  it('关闭最后一页回空态；撤销按原位置重新打开并激活', async () => {
    const bp = await open3()
    await bp.CLOSE_PAGE('p2')
    expect(bp.lastClosedPage).toMatchObject({ url: 'https://b.com', index: 1 })
    await bp.REOPEN_CLOSED_PAGE()
    expect(bp.urlPages.map((p) => p.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com'
    ])
    expect(bp.activePageId).toBe('p4')
    expect(bp.lastClosedPage).toBeNull()
    for (const id of bp.urlPages.map((p) => p.id)) await bp.CLOSE_PAGE(id)
    expect(bp.urlPages).toHaveLength(0)
    expect(bp.activePageId).toBeNull()
    expect(bp.lastClosedPage).not.toBeNull()
  })

  it('关闭其他 / 关闭右侧', async () => {
    const bp = await open3()
    bp.CLOSE_PAGES_TO_RIGHT('p1')
    expect(bp.urlPages.map((p) => p.id)).toEqual(['p1'])
    expect(bp.activePageId).toBe('p1')
    await bp.ADD_WEB_PAGE('x.com')
    bp.CLOSE_OTHER_PAGES('p4')
    expect(bp.urlPages.map((p) => p.id)).toEqual(['p4'])
  })

  it('⌥⌘1/2/3：打开到指定 tab，再按一次同一个则收起', () => {
    const bp = useBrowserPanelStore()
    bp.OPEN_TO_TAB('annotation')
    expect([bp.open, bp.activeTab]).toEqual([true, 'annotation'])
    bp.OPEN_TO_TAB('doc')
    expect([bp.open, bp.activeTab]).toEqual([true, 'doc'])
    bp.OPEN_TO_TAB('doc')
    expect(bp.open).toBe(false)
  })

  it('菜单 / 快捷键经布局入口转给右侧栏', () => {
    const layout = useLayoutStore()
    const toggle = vi.fn()
    const openTo = vi.fn()
    bus.on('right-panel:toggle', toggle)
    bus.on('right-panel:open-to', openTo)
    layout.TOGGLE_LAYOUT_ENTRY('rightPanel')
    layout.TOGGLE_LAYOUT_ENTRY('rightPanelWeb')
    layout.TOGGLE_LAYOUT_ENTRY('rightPanelAnnotation')
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(openTo.mock.calls.map((c) => c[0])).toEqual(['url', 'annotation'])
  })

  it('宽度按比例派生；落盘的是比例；旧偏好缺失/损坏时不崩', () => {
    const ws = useWorkspaceStore()
    const prefs = usePreferencesStore()
    ws.viewportWidth = 1440
    expect(ws.panelWidthPx).toBe(432)
    ws.COMMIT_PANEL_WIDTH(480)
    expect(prefs.rightPanelRatio).toBeCloseTo(0.333, 3)
    ws.viewportWidth = 2240
    expect(ws.panelWidthPx).toBe(746)
    ;(prefs as unknown as Record<string, unknown>).rightPanelRatio = 'bad'
    expect(ws.panelWidthPx).toBe(672)
    ws.SET_PANEL_DRAG_WIDTH(500)
    expect(ws.panelWidthPx).toBe(500)
    ws.RESET_PANEL_RATIO()
    expect(prefs.rightPanelRatio).toBe(0.3)
    ws.viewportWidth = 700
    expect(ws.panelOverlay).toBe(true)
  })
})
