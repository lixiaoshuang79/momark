import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// F1(P0-1)：`startUpAction: 'restoreAll'` 从 schema enum 与默认值里移除后，
// 老用户磁盘上已经存着 `'restoreAll'` 的偏好文件会让 electron-store 在**构造期**
// 就抛 `Config schema violation`——启动即炸。所以迁移必须发生在 `new Store()` 之前。
//
// 这里把 electron-store 换成一个最小的替身，它做一件关键的事：在**构造那一刻**
// 把磁盘上的内容记下来。断言「构造时磁盘上已经是 blank」＝ 断言迁移跑在校验之前，
// 这正是这条修复的承重结构（真 ajv 校验跑不进单测：electron-store 被 vitest 外部化，
// 拿不到被 mock 的 electron，见报告「遗留」）。

const state = vi.hoisted(() => ({
  userDataDir: '',
  constructions: [] as Array<{ file: string; disk: string | null }>
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userDataDir,
    getVersion: () => '1.5.0',
    on: vi.fn(),
    whenReady: () => Promise.resolve()
  },
  ipcMain: { on: vi.fn(), handle: vi.fn(), emit: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] }
}))

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Record<string, unknown> = {}
    private readonly file: string

    constructor(options: { name?: string } = {}) {
      this.file = path.join(state.userDataDir, `${options.name ?? 'config'}.json`)
      state.constructions.push({
        file: this.file,
        disk: (() => {
          try {
            return readFileSync(this.file, 'utf-8')
          } catch {
            return null
          }
        })()
      })
      this.data = readJson(this.file) ?? {}
    }

    get(key: string): unknown {
      return this.data[key]
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
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

    get store(): Record<string, unknown> {
      return this.data
    }
  }
}))

// `init()` 从 `global.__static/preference.json` 读默认值种子。
;(globalThis as unknown as { __static: string }).__static = path.join(process.cwd(), 'static')

const { default: Preference } = await import('main_renderer/preferences')
const schema = (await import('main_renderer/preferences/schema.json')).default as unknown as Record<
  string,
  { enum?: unknown[]; default?: unknown }
>

const dirs: string[] = []
const newUserDataDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'momark-f1-prefs-'))
  dirs.push(dir)
  state.userDataDir = dir
  return dir
}

const writePreferences = (dir: string, data: Record<string, unknown>): void => {
  writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify(data, undefined, '\t'))
}

const lastConstruction = (): { file: string; disk: string | null } =>
  state.constructions[state.constructions.length - 1]!

beforeEach(() => {
  state.constructions.length = 0
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('F1(P0-1) — 偏好文件里遗留的 restoreAll 迁移', () => {
  it('打开 Store 之前磁盘上的 restoreAll 已被改写成 blank', () => {
    const dir = newUserDataDir()
    writePreferences(dir, { startUpAction: 'restoreAll', fileSortOrder: 'asc' })

    const preferences = new Preference({ preferencesPath: dir })

    // 承重断言：Store 构造那一刻，文件里已经不是 restoreAll 了
    // （否则真 ajv 会在构造期抛 Config schema violation）。
    expect(lastConstruction().disk).not.toContain('restoreAll')
    expect(JSON.parse(lastConstruction().disk!).startUpAction).toBe('blank')

    expect(preferences.getItem('startUpAction')).toBe('blank')
    expect(
      JSON.parse(readFileSync(path.join(dir, 'preferences.json'), 'utf-8')).startUpAction
    ).toBe('blank')
  })

  it('只动这一个键：其余内容原样保留', () => {
    const dir = newUserDataDir()
    writePreferences(dir, {
      startUpAction: 'restoreAll',
      fileSortOrder: 'desc',
      theme: 'claude-dark',
      customCss: '.x { color: red }'
    })

    const preferences = new Preference({ preferencesPath: dir })
    expect(preferences.getItem('startUpAction')).toBe('blank')

    const onDisk = JSON.parse(readFileSync(path.join(dir, 'preferences.json'), 'utf-8'))
    expect(onDisk).toMatchObject({
      startUpAction: 'blank',
      fileSortOrder: 'desc',
      theme: 'claude-dark',
      customCss: '.x { color: red }'
    })
  })

  it('已经是合法值的偏好文件不被改写', () => {
    const dir = newUserDataDir()
    writePreferences(dir, { startUpAction: 'openLastFolder' })
    const before = readFileSync(path.join(dir, 'preferences.json'), 'utf-8')

    const preferences = new Preference({ preferencesPath: dir })

    expect(preferences.getItem('startUpAction')).toBe('openLastFolder')
    expect(lastConstruction().disk).toBe(before)
  })

  it('偏好文件损坏时不吞掉启动流程（交给 electron-store 照旧报错）', () => {
    const dir = newUserDataDir()
    writeFileSync(path.join(dir, 'preferences.json'), '{ not json')

    // 迁移自己不该抛：损坏的文件原样留着，后续由 Store 去报它自己的错。
    expect(() => new Preference({ preferencesPath: dir })).not.toThrow(/JSON/)
  })

  it('schema 与默认值种子同步：不再接受 restoreAll，迁移写入的值合法', () => {
    expect(schema.startUpAction!.enum).not.toContain('restoreAll')
    expect(schema.startUpAction!.enum).toContain('blank')
    expect(schema.startUpAction!.default).toBe('blank')

    const seed = JSON.parse(
      readFileSync(path.join(process.cwd(), 'static', 'preference.json'), 'utf-8')
    )
    expect(seed.startUpAction).toBe('blank')
    expect(schema.startUpAction!.enum).toContain(seed.startUpAction)
  })
})
