import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// F1（P0-2）：保存失败 / 用户取消另存时**不得**关窗。
//
// 原实现里 `handleResponseForSave` 在「写盘失败」（内部 catch 吞掉只发通知）和
// 「用户取消另存对话框」两种情况下都返回 resolved undefined，于是
// `mt::close-window-confirm` 的 `Promise.all(...).then(() => 关窗)` 必然关窗——
// 用户点了「保存」却因磁盘满/权限不足/取消另存丢内容。
//
// 这里直接驱动注册在 `mt::close-window-confirm` 上的处理器：
// 保存成功 → 关窗；写盘失败 → 不关窗且对话框点名具体文件。

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  emit: vi.fn(),
  showMessageBox: vi.fn(),
  showSaveDialog: vi.fn(),
  webContentsSend: vi.fn()
}))

vi.mock('electron', () => {
  const win = { id: 1, webContents: { send: state.webContentsSend } }
  return {
    app: {
      getPath: () => '/tmp',
      getVersion: () => '0.0.0',
      on: vi.fn(),
      whenReady: () => Promise.resolve(),
      isReady: () => true,
      quit: vi.fn()
    },
    ipcMain: {
      on: (channel: string, listener: (...args: unknown[]) => unknown) => {
        state.handlers.set(channel, listener)
      },
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        state.handlers.set(channel, listener)
      },
      emit: state.emit,
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn()
    },
    dialog: { showMessageBox: state.showMessageBox, showSaveDialog: state.showSaveDialog },
    BrowserWindow: { fromWebContents: () => win, getAllWindows: () => [win] },
    Menu: {
      setApplicationMenu: vi.fn(),
      buildFromTemplate: vi.fn(() => ({})),
      sendActionToFirstResponder: vi.fn(),
      getApplicationMenu: () => null
    },
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: vi.fn() },
    clipboard: { writeText: vi.fn(), readText: () => '' }
  }
})

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn(), verbose: vi.fn() }
}))

vi.mock('main_renderer/i18n', () => ({
  t: (key: string) => key,
  getCurrentLanguage: () => 'en',
  setLanguage: vi.fn()
}))

vi.mock('main_renderer/utils/pandoc', () => ({
  default: { exists: () => false, toFile: vi.fn(), __esModule: true }
}))

await import('main_renderer/menu/actions/file')

const CLOSE_CONFIRM = 'mt::close-window-confirm'
const CLOSE_BY_ID = 'window-close-by-id'

interface UnsavedFileLike {
  id: string
  filename: string
  pathname?: string
  markdown: string
  options: Record<string, unknown>
  defaultPath?: string
  version?: number
}

const options = {
  encoding: { encoding: 'utf8', isBom: false },
  lineEnding: 'lf',
  adjustLineEndingOnSave: false,
  trimTrailingNewline: 2
}

const event = { sender: {} } as unknown

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'momark-f1-save-'))
  dirs.push(dir)
  return dir
}

// 对话框应答队列：第一个「是否保存」确认框取队列里的值（0 保存 / 1 放弃 / 2 取消），
// 之后出现的（保存失败提示）一律回 1 =「保持打开」，与实现里的 defaultId 一致。
const dialogResponses: number[] = []
beforeEach(() => {
  state.showMessageBox.mockReset()
  state.showMessageBox.mockImplementation(() =>
    Promise.resolve({ response: dialogResponses.length ? dialogResponses.shift()! : 1 })
  )
  state.showSaveDialog.mockReset()
  state.emit.mockReset()
  state.webContentsSend.mockReset()
  dialogResponses.length = 0
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const runCloseConfirm = async (files: UnsavedFileLike[]): Promise<void> => {
  const handler = state.handlers.get(CLOSE_CONFIRM)
  if (!handler) throw new Error('mt::close-window-confirm handler was not registered')
  await handler(event, files)
}

const closeEmitted = (): boolean => state.emit.mock.calls.some((call) => call[0] === CLOSE_BY_ID)

describe('F1(P0-2) — 关窗前保存：只有全部成功才关窗', () => {
  it('全部保存成功 → 关窗', async () => {
    dialogResponses.push(0) // 0 = save
    const dir = tempDir()
    const target = path.join(dir, 'note.md')
    writeFileSync(target, 'old', 'utf-8')

    await runCloseConfirm([
      { id: 'tab-1', filename: 'note.md', pathname: target, markdown: 'new', options }
    ])

    expect(closeEmitted()).toBe(true)
    // 保存成功不弹失败对话框（只有最初那个「是否保存」的确认框）。
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('写盘失败 → 不关窗，并在对话框里点名具体文件', async () => {
    dialogResponses.push(0) // 0 = save
    // 父路径是一个**文件**：ensureDir 会 EEXIST，writeFile 必然失败。
    const dir = tempDir()
    const blocker = path.join(dir, 'blocker.md')
    writeFileSync(blocker, 'x', 'utf-8')
    const target = path.join(blocker, 'note.md')

    await runCloseConfirm([
      { id: 'tab-1', filename: 'note.md', pathname: target, markdown: 'new', options }
    ])

    expect(closeEmitted()).toBe(false)
    // 第 2 个对话框 = 保存失败提示，按钮是 [关闭, 保持打开]，detail 里有文件名。
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
    const failureDialog = state.showMessageBox.mock.calls[1]![1] as {
      detail?: string
      buttons?: string[]
      defaultId?: number
    }
    expect(failureDialog.detail).toContain('note.md')
    expect(failureDialog.buttons).toEqual(['dialog.close', 'dialog.keepOpen'])
    // 默认落在「保持打开」：误按回车不该丢掉未保存内容。
    expect(failureDialog.defaultId).toBe(1)
  })

  it('用户取消另存对话框 → 不关窗（内容还在编辑器里）', async () => {
    dialogResponses.push(0) // 0 = save
    const dir = tempDir()
    state.showSaveDialog.mockResolvedValue({ filePath: undefined, canceled: true })

    await runCloseConfirm([
      {
        id: 'tab-1',
        filename: 'Untitled-1.md',
        pathname: '',
        markdown: 'new',
        options,
        defaultPath: dir
      }
    ])

    expect(closeEmitted()).toBe(false)
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
    const failureDialog = state.showMessageBox.mock.calls[1]![1] as { detail?: string }
    expect(failureDialog.detail).toContain('Untitled-1.md')
  })

  it('用户选择「放弃保存」→ 直接关窗', async () => {
    dialogResponses.push(1) // 1 = dontSave
    await runCloseConfirm([
      {
        id: 'tab-1',
        filename: 'note.md',
        pathname: '/tmp/f1-nonexistent.md',
        markdown: 'x',
        options
      }
    ])

    expect(closeEmitted()).toBe(true)
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('用户点「取消」→ 什么都不做（不关窗、不保存）', async () => {
    dialogResponses.push(2) // 2 = cancel
    await runCloseConfirm([
      {
        id: 'tab-1',
        filename: 'note.md',
        pathname: '/tmp/f1-nonexistent.md',
        markdown: 'x',
        options
      }
    ])

    expect(closeEmitted()).toBe(false)
    expect(state.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('多个文件中有一个失败 → 整体不关窗', async () => {
    dialogResponses.push(0) // 0 = save
    const dir = tempDir()
    const ok = path.join(dir, 'ok.md')
    writeFileSync(ok, 'old', 'utf-8')
    const blocker = path.join(dir, 'blocker.md')
    writeFileSync(blocker, 'x', 'utf-8')
    const bad = path.join(blocker, 'bad.md')

    await runCloseConfirm([
      { id: 'tab-1', filename: 'ok.md', pathname: ok, markdown: 'new', options },
      { id: 'tab-2', filename: 'bad.md', pathname: bad, markdown: 'new', options }
    ])

    expect(closeEmitted()).toBe(false)
    const failureDialog = state.showMessageBox.mock.calls[1]![1] as { detail?: string }
    expect(failureDialog.detail).toContain('bad.md')
  })
})
