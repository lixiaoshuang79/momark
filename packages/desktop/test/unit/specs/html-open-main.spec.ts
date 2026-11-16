import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// 主进程入口统一：所有「打开」入口共用 normalizeDocumentPath 与 EditorWindow.openTabs，
// 按扩展名分流——md 建编辑标签，html 读盘后发 mt::open-html-tab；两者共用去重、
// 文件监视与「最近文件」登记。文件监视对 html 标签只通知变化、不带内容。

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { emit: vi.fn(), on: vi.fn(), handle: vi.fn() },
  screen: {}
}))
vi.mock('electron-window-state', () => ({ default: () => ({}) }))
vi.mock('main_renderer/spellchecker', () => ({ switchLanguage: vi.fn() }))
vi.mock('main_renderer/contextMenu/editor', () => ({ showEditorContextMenu: vi.fn() }))
const readHtmlFileOrNotify = vi.hoisted(() => vi.fn())
vi.mock('main_renderer/filesystem/htmlFile', () => ({ readHtmlFileOrNotify }))
const loadMarkdownFile = vi.hoisted(() => vi.fn())
vi.mock('main_renderer/filesystem/markdown', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadMarkdownFile
}))

const chokidarHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const chokidarWatch = vi.hoisted(() => vi.fn())
vi.mock('chokidar', () => ({
  default: {
    watch: (...args: unknown[]) => {
      chokidarWatch(...args)
      const w: Record<string, unknown> = {}
      w.on = (event: string, handler: (...a: unknown[]) => unknown) => {
        chokidarHandlers.set(event, handler)
        return w
      }
      w.close = vi.fn()
      return w
    }
  }
}))

import { ipcMain } from 'electron'
import { normalizeDocumentPath } from 'main_renderer/filesystem/markdown'
import EditorWindow from 'main_renderer/windows/editor'
import { WindowLifecycle } from 'main_renderer/windows/base'
import Watcher from 'main_renderer/filesystem/watcher'

const dirs: string[] = []
const tmpDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'momark-html-open-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  chokidarHandlers.clear()
})

describe('normalizeDocumentPath', () => {
  it('accepts directories, markdown and html files, and nothing else', () => {
    const root = tmpDir()
    const files = ['a.md', 'b.html', 'c.HTM', 'd.png'].map((name) => path.join(root, name))
    for (const file of files) writeFileSync(file, 'x')
    mkdirSync(path.join(root, 'sub'))

    expect(normalizeDocumentPath(files[0])).toEqual({ isDir: false, path: files[0] })
    expect(normalizeDocumentPath(files[1])).toEqual({ isDir: false, path: files[1] })
    expect(normalizeDocumentPath(files[2])).toEqual({ isDir: false, path: files[2] })
    expect(normalizeDocumentPath(files[3])).toBeNull()
    expect(normalizeDocumentPath(path.join(root, 'sub'))).toMatchObject({ isDir: true })
  })
})

describe('EditorWindow.openTabs', () => {
  interface WindowInternals {
    _openedFiles: string[]
    _filesToOpen: Array<{ kind: string }>
  }
  const makeWindow = (lifecycle: unknown) => {
    const send = vi.fn()
    const addRecentlyUsedDocument = vi.fn()
    const win = Object.create(EditorWindow.prototype) as EditorWindow
    Object.assign(win, {
      lifecycle,
      browserWindow: { webContents: { send }, isDestroyed: () => false },
      _openedFiles: [] as string[],
      _filesToOpen: [],
      _accessor: {
        menu: { addRecentlyUsedDocument },
        preferences: {
          getPreferredEol: () => 'lf',
          getAll: () => ({
            autoGuessEncoding: true,
            trimTrailingNewline: 2,
            autoNormalizeLineEndings: false
          })
        }
      }
    })
    return { win, state: win as unknown as WindowInternals, send, addRecentlyUsedDocument }
  }

  const htmlDoc = { pathname: '/p/proto.html', filename: 'proto.html', html: '<p>hi</p>' }
  const mdDoc = { pathname: '/p/prd.md', markdown: '# PRD' }

  it('routes by extension: markdown → mt::open-new-tab, html → mt::open-html-tab', async () => {
    readHtmlFileOrNotify.mockResolvedValue(htmlDoc)
    loadMarkdownFile.mockResolvedValue(mdDoc)
    const { win, state, send, addRecentlyUsedDocument } = makeWindow(WindowLifecycle.READY)

    win.openTabsFromPaths(['/p/prd.md', '/p/proto.html'])
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))

    expect(send).toHaveBeenCalledWith('mt::open-new-tab', mdDoc, {}, true)
    expect(send).toHaveBeenCalledWith('mt::open-html-tab', htmlDoc, false)
    expect(loadMarkdownFile).toHaveBeenCalledTimes(1)
    expect(readHtmlFileOrNotify).toHaveBeenCalledWith(win.browserWindow, '/p/proto.html')
    expect(state._openedFiles).toEqual(expect.arrayContaining(['/p/prd.md', '/p/proto.html']))
    expect(ipcMain.emit).toHaveBeenCalledWith(
      'watcher-watch-file',
      win.browserWindow,
      '/p/proto.html'
    )
    expect(addRecentlyUsedDocument).toHaveBeenCalledWith('/p/proto.html')
  })

  it('an already opened html file switches to its tab instead of reading it again', () => {
    const { win, state, send } = makeWindow(WindowLifecycle.READY)
    state._openedFiles.push('/p/proto.html')
    win.openTabsFromPaths(['/p/proto.html'])
    expect(send).toHaveBeenCalledWith('mt::switch-tab-by-file_path', '/p/proto.html')
    expect(readHtmlFileOrNotify).not.toHaveBeenCalled()
  })

  it('an unreadable html file opens nothing (main already notified)', async () => {
    readHtmlFileOrNotify.mockResolvedValue(null)
    const { win, state, send } = makeWindow(WindowLifecycle.READY)
    win.openTabsFromPaths(['/p/proto.html'])
    await vi.waitFor(() => expect(readHtmlFileOrNotify).toHaveBeenCalled())
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    expect(state._openedFiles).toEqual([])
  })

  it('queues html files until the window has loaded, alongside markdown', async () => {
    readHtmlFileOrNotify.mockResolvedValue(htmlDoc)
    const { win, state, send } = makeWindow(WindowLifecycle.LOADING)
    win.openTabsFromPaths(['/p/proto.html'])
    await vi.waitFor(() => expect(state._filesToOpen).toHaveLength(1))
    expect(send).not.toHaveBeenCalled()
    expect(state._filesToOpen[0].kind).toBe('html')
  })
})

describe('file watcher for html tabs', () => {
  const makeWatcher = () => {
    const preferences = {
      getItem: vi.fn(() => false),
      getAll: vi.fn(() => ({})),
      getPreferredEol: vi.fn(() => 'lf')
    }
    const send = vi.fn()
    return {
      watcher: new Watcher(preferences as never),
      win: { id: 1, webContents: { send } },
      send
    }
  }
  const ignoredFn = () =>
    (chokidarWatch.mock.calls.at(-1)![1] as { ignored: (p: string, i?: unknown) => boolean })
      .ignored
  const fileInfo = { isDirectory: () => false }

  it('watches an opened html file but keeps html out of the folder tree', () => {
    const { watcher, win } = makeWatcher()
    watcher.watch(win as never, '/p/proto.html', 'file')
    expect(ignoredFn()('/p/proto.html', fileInfo)).toBe(false)

    watcher.watch(win as never, '/p', 'dir')
    expect(ignoredFn()('/p/proto.html', fileInfo)).toBe(true)
    expect(ignoredFn()('/p/prd.md', fileInfo)).toBe(false)
  })

  it('a change only notifies, without reading the page', async () => {
    const root = tmpDir()
    const file = path.join(root, 'proto.html')
    writeFileSync(file, '<p>v2</p>')
    const { watcher, win, send } = makeWatcher()
    watcher.watch(win as never, file, 'file')

    await chokidarHandlers.get('change')!(file)
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    const [channel, payload] = send.mock.calls[0]
    expect(channel).toBe('mt::update-file')
    expect(payload.type).toBe('change')
    expect(payload.change).toMatchObject({ pathname: file, kind: 'html' })
    expect(payload.change).not.toHaveProperty('data')
    expect(loadMarkdownFile).not.toHaveBeenCalled()
  })
})
