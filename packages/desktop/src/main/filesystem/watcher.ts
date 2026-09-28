import path from 'path'
import fsPromises from 'fs/promises'
import log from 'electron-log'
import chokidar, { type FSWatcher } from 'chokidar'
import { minimatch } from 'minimatch'
import { exists } from 'common/filesystem'
import { hasMarkdownExtension } from 'common/filesystem/paths'
import { getUniqueId } from '../utils'
import { loadMarkdownFile } from '../filesystem/markdown'
import { isLinux, isOsx } from '../config'
import type { BrowserWindow } from 'electron'
import type { LineEnding } from '@shared/types/files'
import type Preference from '../preferences'

// TODO(refactor): Please see GH#1035.

export const WATCHER_STABILITY_THRESHOLD = 1000
export const WATCHER_STABILITY_POLL_INTERVAL = 150

/**
 * 轮询模式下的扫描间隔（P3）。
 *
 * chokidar 的默认值是 `interval: 100` / `binaryInterval: 300`——轮询模式下它给
 * 每个被监视的文件挂一个 `fs.watchFile`，100ms 一次 stat。对文件树这种「只要
 * 秒级新鲜度」的场景毫无必要，抬到 1s 可把轮询开销砍到 1/10。只在真正必须轮询
 * 的路径上生效（UNC 共享 / 用户显式开的 watcherUsePolling）。
 */
export const WATCHER_POLL_INTERVAL = 1000

/**
 * 目录初始扫描期间，mtime 落在这个窗口内的文件仍按「新文件」对待、读内容
 * （判据见 `shouldReadContentDuringScan`）。
 */
export const WATCHER_SCAN_FRESH_WINDOW = 10000

/** 无条件忽略：依赖包目录与 asar 包。提到模块作用域——`ignored` 回调对扫描到
 *  的每个路径都要求值一次，正则字面量写在回调里每次都是新建对象。 */
const ALWAYS_IGNORED_RE = /(?:^|[/\\])(?:node_modules|(?:.+\.asar))/

const EVENT_NAME = {
  dir: 'mt::update-object-tree' as const,
  file: 'mt::update-file' as const
}

type WatchType = 'dir' | 'file'

export const isUncPath = (pathname: string): boolean =>
  /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(pathname)

interface IgnoreEntry {
  windowId: number
  pathname: string
  duration: number
  start: Date
}

interface WatcherEntry {
  win: BrowserWindow
  watcher: FSWatcher
  pathname: string
  type: WatchType
  close: () => void
}

/** 打开一个文件时要用的偏好子集（add / change 共用，避免在事件回调里
 *  反复拼参数列表）。 */
interface LoadOptions {
  endOfLine: LineEnding
  autoGuessEncoding: boolean
  trimTrailingNewline: number
  autoNormalizeLineEndings: boolean
}

type ExcludeMatcher = (pathname: string) => boolean

/** minimatch 编译产物里我们用到的那部分（只需要 `match`）。 */
interface CompiledPatternMatcher {
  match(pathname: string): boolean
}

/**
 * 把一个模式编译成匹配函数。
 *
 * minimatch@3 把 `Minimatch` 类挂在导出的函数对象上（`export = minimatch` +
 * namespace），而本仓的 `src/types/shims.d.ts` 只声明了那个函数，所以这里从
 * 函数对象上取构造器。运行时语义与 `minimatch(pathname, pattern, {matchBase:true})`
 * 完全一致（v3 源码里后者就是 `new Minimatch(pattern, options).match(p)`，只多一个
 * 每调用一次的 `assertValidPattern`）——`watcher.spec.ts` 里有逐项等价断言。
 */
const compileExcludePattern = (pattern: string): ExcludeMatcher => {
  const MinimatchCtor = (
    minimatch as unknown as {
      Minimatch?: new (pattern: string, options: { matchBase: boolean }) => CompiledPatternMatcher
    }
  ).Minimatch

  if (typeof MinimatchCtor === 'function') {
    const compiled = new MinimatchCtor(pattern, { matchBase: true })
    return (pathname: string) => compiled.match(pathname)
  }

  // 兜底：拿不到构造器（依赖形态变化）时退回逐次调用，行为不变、只是没省下编译。
  return (pathname: string) => minimatch(pathname, pattern, { matchBase: true })
}

/**
 * 把用户配置的排除模式预编译成匹配函数。
 *
 * 语义与 `common/filesystem/paths.ts` 的 `checkPathExcludePattern` 一致（同一个
 * minimatch、同一组 `{ matchBase: true }` 选项），区别只在编译时机：那个函数每
 * 调用一次就把每个模式重新编译一遍，而 chokidar 的 `ignored` 回调在扫描期间对
 * **每一个**路径都会调用一次——几千个文件的目录就是几万次正则编译。
 */
const compileExcludePatterns = (patterns: unknown): ExcludeMatcher[] => {
  if (!Array.isArray(patterns)) {
    return []
  }
  const matchers: ExcludeMatcher[] = []
  for (const pattern of patterns as readonly string[]) {
    if (typeof pattern !== 'string') {
      continue
    }
    matchers.push(compileExcludePattern(pattern))
  }
  return matchers
}

/**
 * 初始扫描期间的 `add` 事件要不要读这个文件的内容。
 *
 * 渲染层只有一处消费 `data`：侧栏「新建文件」后，等 watcher 的 `add` 事件把
 * 新建文件的空状态灌进当前标签页（`store/project.ts` 的 newFileNameCache 分支
 * → `getFileStateFromData`）。新建文件必然是「刚创建」（mtime 极新）而且通常是
 * 空文件，用这两条判据把它留下，目录里其余几千个既有文件就只发元数据。
 * 扫描结束后（chokidar 的 `ready` 之后）一律照旧读内容。
 */
const shouldReadContentDuringScan = (stats: { size: number; mtimeMs: number }): boolean =>
  stats.size === 0 || Date.now() - stats.mtimeMs < WATCHER_SCAN_FRESH_WINDOW

const add = async (
  win: BrowserWindow,
  pathname: string,
  type: WatchType,
  options: LoadOptions,
  scanning: boolean
): Promise<void> => {
  let stats: Awaited<ReturnType<typeof fsPromises.stat>>
  try {
    stats = await fsPromises.stat(pathname)
  } catch (err) {
    // 扫描与事件之间文件被删除/改名（或权限不足）：这条 add 已经过期，直接丢弃。
    // 必须接住——事件处理器是 async 且无人 await，抛出去就是一个 unhandled
    // rejection（旧实现的 stat 在 try 之外，正是报告里点名的崩溃路径）。
    log.debug('watcher: cannot stat a just-added path, skipping:', pathname, err)
    return
  }

  const { birthtime: birthTime, mtimeMs } = stats
  const isMarkdown = hasMarkdownExtension(pathname)
  const file: {
    pathname: string
    name: string
    isFile: boolean
    isDirectory: boolean
    birthTime: Date
    mtimeMs: number
    isMarkdown: boolean
    data?: Awaited<ReturnType<typeof loadMarkdownFile>>
  } = {
    pathname,
    name: path.basename(pathname),
    isFile: true,
    isDirectory: false,
    birthTime,
    mtimeMs,
    isMarkdown
  }
  if (isMarkdown) {
    // HACK: But this should be removed completely in #1034/#1035.
    if (!scanning || shouldReadContentDuringScan(stats)) {
      try {
        file.data = await loadMarkdownFile(
          pathname,
          options.endOfLine,
          options.autoGuessEncoding,
          options.trimTrailingNewline,
          options.autoNormalizeLineEndings
        )
      } catch (err) {
        // Only notify user about opened files.
        if (type === 'file') {
          win.webContents.send('mt::show-notification', {
            title: 'Watcher I/O error',
            type: 'error',
            message: err instanceof Error ? err.message : String(err)
          })
          return
        }
      }
    }
    win.webContents.send(EVENT_NAME[type], {
      type: 'add',
      change: file
    })
  }
}

const unlink = (win: BrowserWindow, pathname: string, type: WatchType): void => {
  const file = { pathname }
  win.webContents.send(EVENT_NAME[type], {
    type: 'unlink',
    change: file
  })
}

const change = async (
  win: BrowserWindow,
  pathname: string,
  type: WatchType,
  options: LoadOptions
): Promise<void> => {
  if (type === 'dir') {
    // Only send mtimeMs so the sidebar can re-sort; skip loading file content.
    try {
      const stats = await fsPromises.stat(pathname)
      win.webContents.send('mt::update-object-tree', {
        type: 'change',
        change: { pathname, mtimeMs: stats.mtimeMs }
      })
    } catch {
      // File may have been deleted between the event and the stat; ignore.
    }
    return
  }

  const isMarkdown = hasMarkdownExtension(pathname)
  if (isMarkdown) {
    try {
      const [data, stats] = await Promise.all([
        loadMarkdownFile(
          pathname,
          options.endOfLine,
          options.autoGuessEncoding,
          options.trimTrailingNewline,
          options.autoNormalizeLineEndings
        ),
        fsPromises.stat(pathname)
      ])
      const file = { pathname, data, mtimeMs: stats.mtimeMs }
      win.webContents.send('mt::update-file', {
        type: 'change',
        change: file
      })
    } catch (err) {
      if (type === 'file') {
        win.webContents.send('mt::show-notification', {
          title: 'Watcher I/O error',
          type: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }
}

const addDir = (win: BrowserWindow, pathname: string, type: WatchType): void => {
  if (type === 'file') return

  const directory = {
    pathname,
    name: path.basename(pathname),
    isCollapsed: true,
    isDirectory: true,
    isFile: false,
    isMarkdown: false,
    folders: [],
    files: []
  }

  win.webContents.send('mt::update-object-tree', {
    type: 'addDir',
    change: directory
  })
}

const unlinkDir = (win: BrowserWindow, pathname: string, type: WatchType): void => {
  if (type === 'file') return

  const directory = { pathname }
  win.webContents.send('mt::update-object-tree', {
    type: 'unlinkDir',
    change: directory
  })
}

class Watcher {
  private _preferences: Preference
  private _ignoreChangeEvents: IgnoreEntry[]
  watchers: Record<string, WatcherEntry>

  constructor(preferences: Preference) {
    this._preferences = preferences
    this._ignoreChangeEvents = []
    this.watchers = {}
  }

  watch(win: BrowserWindow, watchPath: string, type: WatchType = 'dir'): () => void {
    // P3：macOS 不再强制轮询。chokidar 在 macOS 上默认走 FSEvents；上游那条
    // `isOsx || …` 是历史遗留（本机实测见报告），代价是 chokidar 的 polling
    // 会给每个被监视的文件挂一个 `fs.watchFile`（默认 100ms 一次 stat）：
    // 大目录下 CPU/电量开销显著，而且它还会让 `_shouldIgnoreEvent` 里的 mtime
    // 兜底判据（只在 `!usePolling` 时执行）永远跑不到。
    // 真正必须轮询的只剩两种情况：UNC 路径（fs.watch 在网络共享上枚举不可靠）
    // 与用户显式打开的 `watcherUsePolling`；两者都把间隔抬到 ≥1s。
    const usePolling = isUncPath(watchPath)
      ? true
      : !!this._preferences.getItem<boolean>('watcherUsePolling')

    const id = getUniqueId()

    // 排除模式：编译一次、按偏好引用变化失效重建。旧实现把
    // `preferences.getItem(...)` 放在 `ignored` 回调里——扫描期间每个路径一次
    // 同步读盘（conf 的每次 get 都是读整个偏好文件），而且每个模式每次都要
    // 重新编译。这里 getItem 走内存缓存、模式只在列表变化时重编译。
    let compiledPatterns: unknown
    let excludeMatchers: ExcludeMatcher[] = []
    const isExcluded = (pathname: string): boolean => {
      const patterns = this._preferences.getItem<readonly string[]>('treePathExcludePatterns')
      if (patterns !== compiledPatterns) {
        compiledPatterns = patterns
        excludeMatchers = compileExcludePatterns(patterns)
      }
      for (const matches of excludeMatchers) {
        if (matches(pathname)) {
          return true
        }
      }
      return false
    }

    const watcher = chokidar.watch(watchPath, {
      ignored: (pathname: string, fileInfo?: { isDirectory: () => boolean }) => {
        if (!fileInfo) {
          return ALWAYS_IGNORED_RE.test(pathname)
        }

        if (ALWAYS_IGNORED_RE.test(pathname)) {
          return true
        }

        if (isExcluded(pathname)) {
          return true
        }
        if (fileInfo.isDirectory()) {
          return false
        }
        return !hasMarkdownExtension(pathname)
      },
      ignoreInitial: type === 'file',
      persistent: true,
      ignorePermissionErrors: true,

      depth: type === 'file' ? (isOsx ? 1 : 0) : undefined,

      // Defer events until writes settle only for the file watcher, which
      // reloads file CONTENT on change and would otherwise read a partial file
      // (GH#1043). The directory watcher just lists nodes and re-sorts by mtime,
      // so deferring its `add` events only made new files appear in the sidebar
      // ~1s late (GH#3955).
      ...(type === 'file'
        ? {
            awaitWriteFinish: {
              stabilityThreshold: WATCHER_STABILITY_THRESHOLD,
              pollInterval: WATCHER_STABILITY_POLL_INTERVAL
            }
          }
        : {}),

      ...(usePolling
        ? {
            usePolling: true,
            interval: WATCHER_POLL_INTERVAL,
            binaryInterval: WATCHER_POLL_INTERVAL
          }
        : {})
      // chokidar's `ignored` callback signature varies between versions; this options
      // bag works at runtime but defies the bundled type.
    } as unknown as Parameters<typeof chokidar.watch>[1])

    let disposed = false
    let enospcReached = false
    let renameTimer: NodeJS.Timeout | null = null

    // 目录 watcher 会（`ignoreInitial: false`）在 `ready` 之前把整棵树的每个文件
    // 作为 `add` 事件吐一遍。这期间只发元数据（见 `shouldReadContentDuringScan`
    // 的注释：几千个文件就是几千次读全文 + 几千条大 IPC 消息）。标志位在事件
    // 处理器入口同步取值，避免 stat 期间 `ready` 到达导致同一批事件一半读一半不读。
    let scanning = type === 'dir'

    const loadOptions = (): LoadOptions => {
      const {
        autoGuessEncoding = true,
        trimTrailingNewline = 2,
        autoNormalizeLineEndings = false
      } = this._preferences.getAll()
      return {
        endOfLine: this._preferences.getPreferredEol() as LineEnding,
        autoGuessEncoding,
        trimTrailingNewline,
        autoNormalizeLineEndings
      }
    }

    watcher
      .on('ready', () => {
        scanning = false
      })
      .on('add', async (pathname: string) => {
        const isScanEvent = scanning
        if (!(await this._shouldIgnoreEvent(win.id, pathname, type, usePolling))) {
          add(win, pathname, type, loadOptions(), isScanEvent)
        }
      })
      .on('change', async (pathname: string) => {
        if (!(await this._shouldIgnoreEvent(win.id, pathname, type, usePolling))) {
          change(win, pathname, type, loadOptions())
        }
      })
      .on('unlink', (pathname: string) => unlink(win, pathname, type))
      .on('addDir', (pathname: string) => addDir(win, pathname, type))
      .on('unlinkDir', (pathname: string) => unlinkDir(win, pathname, type))
      .on('raw', (event: string, subpath: string, details: unknown) => {
        if (globalThis.MARKTEXT_DEBUG_VERBOSE >= 3) {
          console.log('watcher: ', event, subpath, details)
        }

        // Fix atomic rename on Linux (chokidar#591).
        if (isLinux && type === 'file' && event === 'rename') {
          if (renameTimer) {
            clearTimeout(renameTimer)
          }
          renameTimer = setTimeout(async () => {
            renameTimer = null
            if (disposed) {
              return
            }

            const fileExists = await exists(watchPath)
            if (fileExists) {
              watcher.unwatch(watchPath)
              watcher.add(watchPath)
            }
          }, 150)
        }
      })
      .on('error', (error: unknown) => {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code === 'ENOSPC') {
          if (!enospcReached) {
            enospcReached = true
            log.warn('inotify limit reached: Too many file descriptors are opened.')

            win.webContents.send('mt::show-notification', {
              title: 'inotify limit reached',
              type: 'warning',
              message:
                'Cannot watch all files and file changes because too many file descriptors are opened.'
            })
          }
        } else {
          log.error('Error while watching files:', error)
        }
      })

    const closeFn = (): void => {
      disposed = true
      if (this.watchers[id]) {
        delete this.watchers[id]
      }
      if (renameTimer) {
        clearTimeout(renameTimer)
        renameTimer = null
      }
      watcher.close()
    }

    this.watchers[id] = {
      win,
      watcher,
      pathname: watchPath,
      type,
      close: closeFn
    }

    return closeFn
  }

  unwatch(win: BrowserWindow, watchPath: string, type: WatchType = 'dir'): void {
    for (const id of Object.keys(this.watchers)) {
      const w = this.watchers[id]
      if (w.win === win && w.pathname === watchPath && w.type === type) {
        w.watcher.close()
        delete this.watchers[id]
        break
      }
    }
  }

  unwatchByWindowId(windowId: number): void {
    const watchers: FSWatcher[] = []
    const watchIds: string[] = []
    for (const id of Object.keys(this.watchers)) {
      const w = this.watchers[id]
      if (w.win.id === windowId) {
        watchers.push(w.watcher)
        watchIds.push(id)
      }
    }
    if (watchers.length) {
      watchIds.forEach((id) => delete this.watchers[id])
      watchers.forEach((watcher) => watcher.close())
    }
  }

  close(): void {
    Object.keys(this.watchers).forEach((id) => this.watchers[id].close())
    this.watchers = {}
    this._ignoreChangeEvents = []
  }

  /**
   * Ignore the next changed event within a certain time for the current file
   * and window. Only valid for files and "add"/"change" events.
   */
  ignoreChangedEvent(
    windowId: number,
    pathname: string,
    duration: number = WATCHER_STABILITY_THRESHOLD + WATCHER_STABILITY_POLL_INTERVAL * 2
  ): void {
    this._ignoreChangeEvents.push({ windowId, pathname, duration, start: new Date() })
  }

  /**
   * Check whether we should ignore the current event because the file may be
   * changed from MarkText itself.
   */
  async _shouldIgnoreEvent(
    winId: number,
    pathname: string,
    type: WatchType,
    usePolling: boolean
  ): Promise<boolean> {
    if (type === 'file') {
      const { _ignoreChangeEvents } = this
      const currentTime = new Date()
      for (let i = 0; i < _ignoreChangeEvents.length; ++i) {
        const { windowId, pathname: pathToIgnore, start, duration } = _ignoreChangeEvents[i]
        if (windowId === winId && pathToIgnore === pathname) {
          _ignoreChangeEvents.splice(i, 1)
          --i

          // Modification origin is the editor and we should ignore the event.
          if (currentTime.getTime() - start.getTime() < duration) {
            return true
          }

          // Try to catch cloud drives that emit the change event not
          // immediately or re-sync the change (GH#3044).
          if (!usePolling) {
            try {
              const fileInfo = await fsPromises.stat(pathname)
              if (fileInfo.mtime.getTime() - start.getTime() < duration) {
                if (globalThis.MARKTEXT_DEBUG_VERBOSE >= 3) {
                  console.log(
                    `Ignoring file event after "stat": current="${currentTime.toISOString()}", start="${start.toISOString()}", file="${fileInfo.mtime.toISOString()}".`
                  )
                }
                return true
              }
            } catch (error) {
              console.error('Failed to "stat" file to determine modification time:', error)
            }
          }
        }
      }
    }
    return false
  }
}

export default Watcher
