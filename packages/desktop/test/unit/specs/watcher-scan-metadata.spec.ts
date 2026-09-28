import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// ────────────────────────────────────────────────────────────────────────────
// P3 主进程性能（watcher 部分）的行为断言：
//   1) 目录初始扫描（chokidar 'ready' 之前）只发元数据，不读全文；
//      渲染层唯一用到 `data` 的「侧栏新建文件」场景（新文件 = mtime 极新 / 空
//      文件）仍带内容；
//   2) 扫描期间 stat 失败不再变成 unhandled rejection；
//   3) macOS 不再强制 usePolling，必须轮询的场景间隔 ≥1s；
//   4) 排除模式只编译一次，且结果与 `checkPathExcludePattern` 完全一致。
// ────────────────────────────────────────────────────────────────────────────

const stats = vi.hoisted(() => ({ compiled: 0, fallback: 0 }))

const watchMock = vi.fn()
let handlers = new Map<string, (...args: unknown[]) => unknown>()

const makeFakeWatcher = (): Record<string, ReturnType<typeof vi.fn>> => {
  const w: Record<string, ReturnType<typeof vi.fn>> = {}
  w.on = vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(event, handler)
    return w
  })
  w.close = vi.fn()
  w.add = vi.fn()
  w.unwatch = vi.fn()
  return w
}

vi.mock('chokidar', () => ({
  default: {
    watch: (...args: unknown[]) => {
      watchMock(...args)
      return makeFakeWatcher()
    }
  }
}))

// minimatch：包一层计数替身，真实匹配仍走原实现（v3 的类挂在函数对象上）。
vi.mock('minimatch', async () => {
  const { createRequire } = await import('module')
  const real = createRequire(import.meta.url)('minimatch') as {
    (p: string, pattern: string, opts?: unknown): boolean
    Minimatch: new (pattern: string, opts?: unknown) => { match(p: string): boolean }
  }
  class CountingMinimatch extends real.Minimatch {
    constructor(pattern: string, opts?: unknown) {
      super(pattern, opts)
      stats.compiled++
    }
  }
  const countingMinimatch = (p: string, pattern: string, opts?: unknown): boolean => {
    stats.fallback++
    return real(p, pattern, opts)
  }
  ;(countingMinimatch as unknown as { Minimatch: unknown }).Minimatch = CountingMinimatch
  return { minimatch: countingMinimatch }
})

// 全文读取：这是本组用例要盯着「没被调用」的那个昂贵操作（顺带避开原生 ced）。
const loadMarkdownFileMock = vi.hoisted(() => vi.fn())
vi.mock('main_renderer/filesystem/markdown', () => ({
  loadMarkdownFile: loadMarkdownFileMock,
  normalizeMarkdownPath: (p: string) => ({ path: p, isDir: false })
}))
vi.mock('ced', () => ({ default: () => 'UTF-8' }))

import Watcher, { isUncPath, WATCHER_POLL_INTERVAL } from 'main_renderer/filesystem/watcher'
import { checkPathExcludePattern } from 'common/filesystem/paths'

const dirs: string[] = []
const tmpDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'momark-p3-watcher-'))
  dirs.push(dir)
  return dir
}

/** 建一个真文件，把 mtime 调到指定秒数之前。 */
const makeFile = (filePath: string, mtimeAgeMs = 0, content = ''): void => {
  writeFileSync(filePath, content)
  if (mtimeAgeMs > 0) {
    const when = new Date(Date.now() - mtimeAgeMs)
    utimesSync(filePath, when, when)
  }
}

const lastOptions = (): Record<string, unknown> => {
  const calls = watchMock.mock.calls
  return calls[calls.length - 1][1] as Record<string, unknown>
}

const sentChanges = (send: ReturnType<typeof vi.fn>, channel: string): unknown[] =>
  send.mock.calls.filter((c) => c[0] === channel).map((c) => (c[1] as { change: unknown }).change)

interface FakeWin {
  id: number
  webContents: { send: ReturnType<typeof vi.fn> }
}

const makeWin = (): FakeWin => ({ id: 1, webContents: { send: vi.fn() } })

let excludePatterns: string[]

const makeWatcher = (): { watcher: Watcher; win: FakeWin } => {
  const preferences = {
    getItem: vi.fn((key: string) => (key === 'treePathExcludePatterns' ? excludePatterns : false)),
    getAll: vi.fn(() => ({ autoGuessEncoding: true, trimTrailingNewline: 2 })),
    getPreferredEol: vi.fn(() => 'lf')
  }
  return { watcher: new Watcher(preferences as never), win: makeWin() }
}

beforeEach(() => {
  watchMock.mockClear()
  handlers = new Map()
  excludePatterns = []
  stats.compiled = 0
  stats.fallback = 0
  loadMarkdownFileMock.mockReset()
  loadMarkdownFileMock.mockResolvedValue({ markdown: '# 内容', pathname: '/x.md' })
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('P3 — 目录初始扫描不再读全文', () => {
  it('ready 之前的 add 只发元数据（含 mtimeMs / birthTime），不读文件内容', async () => {
    const root = tmpDir()
    const file = path.join(root, 'old.md')
    makeFile(file, 60 * 60 * 1000, '# 老文件')

    const { watcher, win } = makeWatcher()
    watcher.watch(win as never, root, 'dir')

    await handlers.get('add')!(file)
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalled())

    const changes = sentChanges(win.webContents.send, 'mt::update-object-tree')
    expect(changes).toHaveLength(1)
    const change = changes[0] as Record<string, unknown>
    // 元数据照旧
    expect(change.pathname).toBe(file)
    expect(change.name).toBe('old.md')
    expect(change.isMarkdown).toBe(true)
    expect(change.isFile).toBe(true)
    expect(change.birthTime).toBeInstanceOf(Date)
    expect(typeof change.mtimeMs).toBe('number')
    // 承重断言：没有读全文
    expect(change.data).toBeUndefined()
    expect(loadMarkdownFileMock).not.toHaveBeenCalled()
  })

  it('ready 之后（实时 add）照旧带内容——侧栏新建文件流程依赖它', async () => {
    const root = tmpDir()
    const file = path.join(root, 'new.md')
    makeFile(file, 0, '')

    const { watcher, win } = makeWatcher()
    watcher.watch(win as never, root, 'dir')
    await handlers.get('ready')!()

    await handlers.get('add')!(file)
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalled())

    const change = sentChanges(win.webContents.send, 'mt::update-object-tree')[0] as Record<
      string,
      unknown
    >
    expect(loadMarkdownFileMock).toHaveBeenCalledTimes(1)
    expect(change.data).toEqual({ markdown: '# 内容', pathname: '/x.md' })
  })

  it('扫描期间仍为「刚创建（mtime 极新）」与「空文件」读内容（新建文件场景）', async () => {
    const root = tmpDir()
    const fresh = path.join(root, 'fresh.md')
    const empty = path.join(root, 'empty.md')
    makeFile(fresh, 0, '刚写完')
    makeFile(empty, 60 * 60 * 1000, '')

    const { watcher, win } = makeWatcher()
    watcher.watch(win as never, root, 'dir')

    await handlers.get('add')!(fresh)
    await handlers.get('add')!(empty)
    await vi.waitFor(() =>
      expect(sentChanges(win.webContents.send, 'mt::update-object-tree')).toHaveLength(2)
    )

    expect(loadMarkdownFileMock).toHaveBeenCalledTimes(2)
    const changes = sentChanges(win.webContents.send, 'mt::update-object-tree') as Array<
      Record<string, unknown>
    >
    expect(changes.every((c) => c.data !== undefined)).toBe(true)
  })

  it('扫描期间文件被删（stat 失败）→ 静默跳过，既不抛也不发消息', async () => {
    const root = tmpDir()
    const ghost = path.join(root, 'ghost.md')

    const { watcher, win } = makeWatcher()
    watcher.watch(win as never, root, 'dir')

    // 事件到达时文件已经不在磁盘上：旧实现的 `await stat()` 在 try 之外，
    // 异常会从 async 处理器里逃出去变成 unhandled rejection。
    await expect(handlers.get('add')!(ghost)).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})

describe('P3 — 轮询策略与排除模式', () => {
  it('macOS（本机）不再强制 usePolling', () => {
    const { watcher, win } = makeWatcher()
    watcher.watch(win as never, tmpDir(), 'dir')
    expect(lastOptions().usePolling).toBeFalsy()
    expect(lastOptions().interval).toBeUndefined()
  })

  it('UNC 根仍然轮询（fs.watch 在网络共享上不可靠），但间隔抬到 1s', () => {
    const { watcher, win } = makeWatcher()
    const unc = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project'
    expect(isUncPath(unc)).toBe(true)
    watcher.watch(win as never, unc, 'dir')
    expect(lastOptions().usePolling).toBe(true)
    expect(lastOptions().interval).toBe(WATCHER_POLL_INTERVAL)
    expect(WATCHER_POLL_INTERVAL).toBeGreaterThanOrEqual(1000)
  })

  it('用户显式打开 watcherUsePolling 时同样按 ≥1s 轮询', () => {
    const preferences = {
      getItem: vi.fn((key: string) => (key === 'watcherUsePolling' ? true : [])),
      getAll: vi.fn(() => ({})),
      getPreferredEol: vi.fn(() => 'lf')
    }
    const watcher = new Watcher(preferences as never)
    watcher.watch(makeWin() as never, tmpDir(), 'file')
    expect(lastOptions().usePolling).toBe(true)
    expect(lastOptions().interval).toBe(WATCHER_POLL_INTERVAL)
  })

  it('排除模式只编译一次：200 个路径共享同一份编译结果', () => {
    excludePatterns = ['**/node_modules/**', '**/.git/**']
    const { watcher, win } = makeWatcher()
    watcher.watch(win as never, tmpDir(), 'dir')

    const ignored = lastOptions().ignored as (p: string, f?: unknown) => boolean
    const dirInfo = { isDirectory: () => true }

    stats.compiled = 0
    stats.fallback = 0
    for (let i = 0; i < 200; i++) {
      ignored(path.join('/root', 'a', `f${i}.md`), dirInfo)
    }

    // 两个模式 → 两次编译，且与路径数量无关（旧实现是 200 × 2 次）。
    expect(stats.compiled).toBe(2)
    // 走的是编译后的匹配器，不是逐次调用 minimatch() 的兜底路径。
    expect(stats.fallback).toBe(0)
  })

  it('模式变化后重新编译一次（偏好改了不必重开目录）', () => {
    excludePatterns = ['**/.git/**']
    const { watcher, win } = makeWatcher()
    watcher.watch(win as never, tmpDir(), 'dir')
    const ignored = lastOptions().ignored as (p: string, f?: unknown) => boolean
    const dirInfo = { isDirectory: () => true }

    stats.compiled = 0
    ignored('/root/a.md', dirInfo)
    expect(stats.compiled).toBe(1)

    excludePatterns = ['**/.git/**', '**/build/**']
    ignored('/root/a.md', dirInfo)
    expect(stats.compiled).toBe(3)
  })

  it('编译后的匹配结果与 checkPathExcludePattern 完全一致', () => {
    const patterns = ['**/node_modules/**', '*.tmp.md', '.git/**', 'build', '#comment-pattern']
    excludePatterns = patterns
    const { watcher, win } = makeWatcher()
    watcher.watch(win as never, tmpDir(), 'dir')
    const ignored = lastOptions().ignored as (
      p: string,
      f?: { isDirectory: () => boolean }
    ) => boolean

    // 用目录身份调用：此时 `ignored` 的判定只剩「排除模式」这一条（非目录还会
    // 额外叠加「非 markdown 一律忽略」，那条与本等价性无关）。
    // 候选里刻意不含 node_modules/.asar —— 那条走的是内置正则，与用户模式无关。
    const dirInfo = { isDirectory: () => true }
    const candidates = [
      '/root/a.md',
      '/root/a.tmp.md',
      '/root/.git/config',
      '/root/build',
      '/root/build/a.md',
      '/root/#comment-pattern',
      'C:\\proj\\build\\a.md',
      '/root/sub/deep/b.md',
      '/root/other.md'
    ]

    for (const candidate of candidates) {
      expect(ignored(candidate, dirInfo)).toBe(checkPathExcludePattern(candidate, patterns))
    }

    // 顺带钉住两个具体结论，避免「两边都错成一样」的假等价。
    expect(ignored('/root/build', dirInfo)).toBe(true)
    expect(ignored('/root/other.md', dirInfo)).toBe(false)
    // 内置忽略名单不受用户模式影响（与旧实现一致）。
    expect(ignored('/root/node_modules', dirInfo)).toBe(true)
    expect(ignored('/root/x.asar/y.md', dirInfo)).toBe(true)
  })
})
