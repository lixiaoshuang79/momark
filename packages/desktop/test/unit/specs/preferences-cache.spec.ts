import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// ────────────────────────────────────────────────────────────────────────────
// P3 主进程性能（preferences 部分）的行为断言。
//
// 背景：electron-store 底层的 conf，**每一次** `get(key)` / `store` 访问都是
// 一次 `readFileSync` + `JSON.parse` + ajv 全量校验 + 顶层拷贝。watcher 的每个
// 文件事件、菜单/窗口的每次刷新都会读偏好，大目录扫描时就是几千次同步读盘。
// 改成内存缓存后：
//   1) 构造之后再读偏好，不再访问底层 store（＝不再读盘/校验）；
//   2) 写入成功后缓存立刻反映新值（getItem/getAll 与磁盘一致）；
//   3) 写入失败（schema 校验抛错）时缓存与广播都保持旧值；
//   4) getAll() 的返回值仍然是「调用方独占的副本」。
// ────────────────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  userDataDir: '',
  storeReads: 0,
  sets: [] as Array<{ key: unknown; value?: unknown }>,
  events: [] as string[],
  /** 让下一次 `set` 抛错（模拟 ajv schema 校验失败）。 */
  failNextSet: false
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userDataDir,
    getVersion: () => '1.5.0',
    on: vi.fn(),
    whenReady: () => Promise.resolve()
  },
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
    emit: vi.fn((channel: string) => {
      state.events.push(channel)
    })
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] }
}))

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Record<string, unknown> = {}
    private readonly file: string

    constructor(options: { name?: string } = {}) {
      this.file = path.join(state.userDataDir, `${options.name ?? 'config'}.json`)
      try {
        this.data = JSON.parse(readFileSync(this.file, 'utf-8')) as Record<string, unknown>
      } catch {
        this.data = {}
      }
    }

    get(key: string): unknown {
      return this.data[key]
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (state.failNextSet) {
        state.failNextSet = false
        throw new Error(
          'Config schema violation: `theme` must be equal to one of the allowed values'
        )
      }
      state.sets.push({ key, value })
      if (typeof key === 'string') {
        this.data[key] = value
      } else {
        Object.assign(this.data, key)
      }
      writeFileSync(this.file, JSON.stringify(this.data, undefined, '\t'))
    }

    delete(key: string): void {
      delete this.data[key]
      writeFileSync(this.file, JSON.stringify(this.data, undefined, '\t'))
    }

    /** 每次读取都要「读盘 + 校验 + 拷贝」——这里用计数代表那个成本。 */
    get store(): Record<string, unknown> {
      state.storeReads++
      return this.data
    }
  }
}))

// `init()` 从 `global.__static/preference.json` 读默认值种子。
;(globalThis as unknown as { __static: string }).__static = path.join(process.cwd(), 'static')

const { default: Preference } = await import('main_renderer/preferences')

const dirs: string[] = []
const newUserDataDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'momark-p3-prefs-'))
  dirs.push(dir)
  state.userDataDir = dir
  return dir
}

/** 造一个「已有偏好文件」的场景（首启分支会把种子写进去）。 */
const makePreference = (initial?: Record<string, unknown>): InstanceType<typeof Preference> => {
  const dir = newUserDataDir()
  if (initial) {
    writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify(initial, undefined, '\t'))
  }
  return new Preference({ preferencesPath: dir })
}

beforeEach(() => {
  state.storeReads = 0
  state.sets = []
  state.events = []
  state.failNextSet = false
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('P3 — 偏好读路径走内存缓存', () => {
  it('构造之后再多的 getItem/getAll 都不再访问底层 store（＝不再读盘+ajv 校验）', () => {
    const preferences = makePreference({ theme: 'claude-light', autoSave: true })

    const readsAfterConstruction = state.storeReads
    expect(readsAfterConstruction).toBeGreaterThan(0)

    for (let i = 0; i < 50; i++) {
      preferences.getItem('theme')
      preferences.getItem('treePathExcludePatterns')
    }
    for (let i = 0; i < 10; i++) {
      preferences.getAll()
    }

    expect(state.storeReads).toBe(readsAfterConstruction)
  })

  it('watcher 事件式的热读：500 次 getItem 也不产生一次 store 读', () => {
    const preferences = makePreference({ autoGuessEncoding: true })
    const before = state.storeReads
    let seen = 0
    for (let i = 0; i < 500; i++) {
      seen += preferences.getItem<boolean>('autoGuessEncoding') ? 1 : 0
    }
    expect(seen).toBe(500)
    expect(state.storeReads).toBe(before)
  })

  it('写入后缓存立刻反映新值，且与磁盘一致', () => {
    const preferences = makePreference({ theme: 'claude-light' })
    const before = state.storeReads

    preferences.setItem('theme', 'claude-dark')

    expect(preferences.getItem('theme')).toBe('claude-dark')
    expect((preferences.getAll() as Record<string, unknown>).theme).toBe('claude-dark')
    // 读缓存不该顺带读盘
    expect(state.storeReads).toBe(before)
    // 落盘确实发生了
    expect(
      JSON.parse(readFileSync(path.join(state.userDataDir, 'preferences.json'), 'utf-8')).theme
    ).toBe('claude-dark')
    expect(state.events).toContain('broadcast-preferences-changed')
  })

  it('写入被 schema 拒绝时缓存与广播都保持旧值', () => {
    const preferences = makePreference({ theme: 'claude-light' })
    const before = state.storeReads
    state.events = []

    state.failNextSet = true
    expect(() => preferences.setItem('theme', 'not-a-theme')).toThrow(/schema violation/)

    expect(preferences.getItem('theme')).toBe('claude-light')
    expect((preferences.getAll() as Record<string, unknown>).theme).toBe('claude-light')
    expect(state.storeReads).toBe(before)
    expect(state.events).not.toContain('broadcast-preferences-changed')
  })

  it('getAll() 返回的是调用方独占的副本（改写它不会污染缓存）', () => {
    const preferences = makePreference({ theme: 'claude-light' })

    const snapshot = preferences.getAll() as Record<string, unknown>
    snapshot.theme = 'tampered'
    delete snapshot.autoSave
    snapshot.injected = true

    expect(preferences.getItem('theme')).toBe('claude-light')
    expect((preferences.getAll() as Record<string, unknown>).injected).toBeUndefined()
  })

  it('首启：种子写完即进缓存，不必再读一次盘', () => {
    // 不给 preferences.json → 走 `store.set(defaultSettings)` 分支
    const preferences = makePreference()
    expect(state.sets.length).toBeGreaterThan(0)

    const before = state.storeReads
    expect(preferences.getItem('autoSave')).toBe(false)
    expect(preferences.getItem('autoSaveDelay')).toBe(5000)
    expect((preferences.getAll() as Record<string, unknown>).theme).toBe('claude-light')
    expect(state.storeReads).toBe(before)
  })

  it('键集迁移（删除过时键/补新键）后缓存与文件一致', () => {
    // `__outdatedKey` 不在 schema/种子里 → init() 的迁移分支会删掉它
    const preferences = makePreference({ theme: 'claude-light', __outdatedKey: 1 })

    expect((preferences.getAll() as Record<string, unknown>).__outdatedKey).toBeUndefined()
    expect(preferences.getItem('theme')).toBe('claude-light')
    const onDisk = JSON.parse(
      readFileSync(path.join(state.userDataDir, 'preferences.json'), 'utf-8')
    ) as Record<string, unknown>
    expect(onDisk.__outdatedKey).toBeUndefined()
    expect(onDisk.theme).toBe('claude-light')
  })
})
