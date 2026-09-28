import { beforeEach, describe, expect, it, vi } from 'vitest'

// ────────────────────────────────────────────────────────────────────────────
// P3 主进程稳定性：菜单侧不再给「过期窗口 id」抛异常。
//
// `mt::update-line-ending-menu` 是唯一一个没有 `has(windowId)` 前置检查的同族
// handler。窗口刚关掉时渲染层仍可能发出这条消息（`removeWindowMenu` 已经把菜单
// 删了），于是 `getWindowMenuById` 抛 `Cannot find window menu for id …` —— 一个
// 会反复出现的异常，配上未捕获异常处理器就是「弹窗风暴」。
// ────────────────────────────────────────────────────────────────────────────

const ipcMainMock = vi.hoisted(() => ({
  on: vi.fn(),
  emit: vi.fn(),
  handle: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    on: vi.fn(),
    addRecentDocument: vi.fn(),
    getVersion: () => '1.5.0'
  },
  Menu: class {},
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] }
}))

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

vi.mock('common/filesystem', () => ({
  ensureDirSync: vi.fn(),
  isDirectory2: () => false,
  isFile2: () => false
}))

vi.mock('main_renderer/utils/internalIpc', () => ({ onInternalChannel: vi.fn() }))
vi.mock('main_renderer/i18n', () => ({ setLanguage: vi.fn(), t: (key: string) => key }))
vi.mock('main_renderer/menu/templates', () => ({ default: vi.fn(), configSettingMenu: vi.fn() }))
vi.mock('main_renderer/menu/actions/edit', () => ({ updateSidebarMenu: vi.fn() }))
vi.mock('main_renderer/menu/actions/format', () => ({ updateFormatMenu: vi.fn() }))
vi.mock('main_renderer/menu/actions/paragraph', () => ({ updateSelectionMenus: vi.fn() }))
vi.mock('main_renderer/menu/actions/view', () => ({ viewLayoutChanged: vi.fn() }))

import log from 'electron-log'
import AppMenu, { MenuType } from 'main_renderer/menu'

type Handler = (event: unknown, windowId: number, lineEnding: string) => void

const handlerFor = (channel: string): Handler => {
  const call = ipcMainMock.on.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`no ipcMain handler registered for ${channel}`)
  return call[1] as Handler
}

/** 造一个「窗口 1」的菜单替身（条目对象要保持同一引用，代码是原地改 checked）。 */
const makeWindowMenu = () => {
  const entries: Record<string, { checked: boolean }> = {
    crlfLineEndingMenuEntry: { checked: false },
    lfLineEndingMenuEntry: { checked: false }
  }
  return {
    entries,
    getMenuItemById: (id: string) => entries[id]
  }
}

const makeMenuInstance = (): AppMenu => {
  const preferences = {
    getItem: vi.fn((key: string) => (key === 'language' ? 'zh-CN' : undefined)),
    getAll: vi.fn(() => ({}))
  }
  const keybindings = { getAccelerator: vi.fn(() => undefined) }
  return new AppMenu(preferences as never, keybindings as never, '/tmp/userdata')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('P3 — 菜单 handler 对过期窗口 id 不再抛异常', () => {
  it('mt::update-line-ending-menu 收到不存在的窗口 id：不抛、记日志', () => {
    const menu = makeMenuInstance()

    expect(() => handlerFor('mt::update-line-ending-menu')({}, 999, 'lf')).not.toThrow()
    expect(log.error).toHaveBeenCalled()
  })

  it('窗口存在时仍然正常更新（守卫不会误杀正常路径）', () => {
    const menu = makeMenuInstance()
    const windowMenu = makeWindowMenu()
    menu.windowMenus.set(1, { menu: windowMenu as never, type: MenuType.EDITOR })

    const crlfEntry = windowMenu.entries.crlfLineEndingMenuEntry
    expect(() => handlerFor('mt::update-line-ending-menu')({}, 1, 'crlf')).not.toThrow()
    expect(crlfEntry.checked).toBe(true)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('反复收到过期 id 也只是反复记日志，不再抛（弹窗风暴的源头）', () => {
    makeMenuInstance()
    const handler = handlerFor('mt::update-line-ending-menu')

    for (let i = 0; i < 20; i++) {
      expect(() => handler({}, 4242, 'lf')).not.toThrow()
    }
    expect(log.error).toHaveBeenCalledTimes(20)
  })
})
