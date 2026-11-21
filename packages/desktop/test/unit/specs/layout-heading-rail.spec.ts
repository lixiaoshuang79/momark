import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.hoisted(() => {
  const w = globalThis as unknown as { window?: { path?: { sep: string } } }
  w.window ??= {}
  w.window.path ??= { sep: '/' }
  // 旧侧栏宽度缓存：layout 模块加载时应清掉。
  globalThis.localStorage?.setItem('side-bar-width', '320')
})

vi.mock('@/store/bufferedState', () => ({ debouncedSendBufferedState: vi.fn() }))

import { useLayoutStore, createBufferedLayoutState } from '@/store/layout'
import { usePreferencesStore } from '@/store/preferences'
import bus from '@/bus'

const win = window as unknown as {
  electron?: { ipcRenderer: { on: Mock; send: Mock; invoke: Mock } }
  marktext?: { env: { windowId: number } }
}

const ipcHandlers = new Map<string, (...args: unknown[]) => void>()

describe('layout store after the left sidebar removal', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    win.electron = {
      ipcRenderer: {
        on: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
          ipcHandlers.set(channel, cb)
          return () => {}
        }),
        send: vi.fn(),
        invoke: vi.fn(() => Promise.resolve(false))
      }
    }
    win.marktext = { env: { windowId: 7 } }
    setActivePinia(createPinia())
  })

  afterEach(() => {
    bus.all?.clear?.()
    delete win.electron
    delete win.marktext
    vi.clearAllMocks()
  })

  const sent = (channel: string) =>
    win.electron!.ipcRenderer.send.mock.calls.filter(([c]) => c === channel)

  it('drops the legacy side-bar width cache on load', () => {
    expect(localStorage.getItem('side-bar-width')).toBeNull()
  })

  it('defaults to dash-only rail (not pinned) and a closed folder drawer', () => {
    const layout = useLayoutStore()
    expect(usePreferencesStore().headingRailPinned).toBe(false)
    expect(layout.folderDrawerOpen).toBe(false)
    expect(layout.railWidth).toBe(0)
    expect('showSideBar' in layout).toBe(false)
  })

  it('ignores legacy sidebar fields in buffered layout state', () => {
    expect(
      createBufferedLayoutState({
        rightColumn: 'toc',
        showSideBar: true,
        sideBarWidth: 9999,
        showTabBar: true
      })
    ).toEqual({ showTabBar: true })
    expect(createBufferedLayoutState(null)).toBeNull()

    const layout = useLayoutStore()
    layout.RESTORE_BUFFERED_STATE({ showSideBar: true, sideBarWidth: 500, showTabBar: true })
    expect(layout.showTabBar).toBe(true)
    expect(usePreferencesStore().headingRailPinned).toBe(false)
    expect(layout.CREATE_BUFFERED_STATE()).toEqual({ showTabBar: true })
  })

  it('toggles and persists the pinned heading titles preference', () => {
    const layout = useLayoutStore()
    layout.TOGGLE_LAYOUT_ENTRY('headingRailPinned')
    expect(usePreferencesStore().headingRailPinned).toBe(true)
    expect(sent('mt::set-user-preference')).toEqual([
      ['mt::set-user-preference', { headingRailPinned: true }]
    ])
    layout.SET_HEADING_RAIL_PINNED(true)
    expect(sent('mt::set-user-preference')).toHaveLength(1)
    layout.TOGGLE_LAYOUT_ENTRY('headingRailPinned')
    expect(usePreferencesStore().headingRailPinned).toBe(false)
  })

  it('routes the menu / shortcut IPC and the bus to the same toggles and syncs the menu', async () => {
    const layout = useLayoutStore()
    layout.LISTEN_FOR_LAYOUT()

    ipcHandlers.get('mt::toggle-view-layout-entry')!({}, 'headingRailPinned')
    expect(usePreferencesStore().headingRailPinned).toBe(true)
    expect(sent('mt::view-layout-changed').at(-1)).toEqual([
      'mt::view-layout-changed',
      7,
      { showTabBar: false, headingRailPinned: true }
    ])

    bus.emit('view:toggle-layout-entry', 'folderDrawer')
    expect(layout.folderDrawerOpen).toBe(true)
    ipcHandlers.get('mt::toggle-view-layout-entry')!({}, 'folderDrawer')
    expect(layout.folderDrawerOpen).toBe(false)

    // 别的窗口改了偏好（广播进来）：本窗口菜单勾选跟上。
    await nextTick()
    const before = sent('mt::view-layout-changed').length
    usePreferencesStore().SET_USER_PREFERENCE({ headingRailPinned: false })
    await nextTick()
    expect(sent('mt::view-layout-changed').length).toBe(before + 1)
    expect(sent('mt::view-layout-changed').at(-1)![2]).toEqual({
      showTabBar: false,
      headingRailPinned: false
    })
    expect(sent('mt::update-sidebar-menu')).toHaveLength(0)
  })

  it('normalises the reported rail width', () => {
    const layout = useLayoutStore()
    layout.SET_RAIL_WIDTH(48.4)
    expect(layout.railWidth).toBe(48)
    layout.SET_RAIL_WIDTH(-5)
    expect(layout.railWidth).toBe(0)
    layout.SET_RAIL_WIDTH(Number.NaN)
    expect(layout.railWidth).toBe(0)
  })
})
