import fs from 'fs'
import path from 'path'
import Store, { type Schema } from 'electron-store'
import { BrowserWindow, ipcMain } from 'electron'
import log from 'electron-log'
import { isWindows } from '../config'
import { hasSameKeys } from '../utils'
import { onInternalChannel } from '../utils/internalIpc'
import { TypedEmitter } from '@shared/types/typedEmitter'
import type { IUserPreferences } from '@shared/types/preferences'
import schema from './schema.json'

const PREFERENCES_FILE_NAME = 'preferences'

/**
 * F1(P0-1)：`startUpAction: 'restoreAll'` 已从 schema enum 与默认值里移除
 * （恢复上次会话的链路早就没了——见 `src/main/app/index.ts` 的注释）。
 * electron-store 用 ajv 校验**整个**偏好文件，老用户磁盘上留着的 `'restoreAll'`
 * 会让 `new Store()` 直接抛 `Config schema violation`，启动即炸。
 * 所以必须在打开 Store **之前**把旧值改写成 `'blank'`（欢迎页，与「冷启动进
 * 欢迎页」的现状一致），只动这一个键、其余内容与格式（tab 缩进，同 conf 的
 * 序列化）保持原样。
 */
const migrateLegacyStartUpAction = (preferencesPath: string): void => {
  const file = path.join(preferencesPath, `./${PREFERENCES_FILE_NAME}.json`)
  try {
    if (!fs.existsSync(file)) {
      return
    }
    const raw = fs.readFileSync(file, { encoding: 'utf8' })
    if (!raw.trim()) {
      return
    }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || parsed.startUpAction !== 'restoreAll') {
      return
    }
    parsed.startUpAction = 'blank'
    fs.writeFileSync(file, JSON.stringify(parsed, undefined, '\t'), { encoding: 'utf8' })
    log.info("Preferences migration: startUpAction 'restoreAll' -> 'blank'")
  } catch (err) {
    // 文件损坏/不可写时不做任何处理，让 electron-store 按原有方式报错。
    log.error('Preferences migration (startUpAction) failed:', err)
  }
}

// The Preference class extends EventEmitter but does not currently emit any
// events itself — keep the event map empty until concrete events are added.
type PreferenceEvents = Record<string, unknown[]>

// Structural subset of EnvPaths/AppPaths — only `preferencesPath` is read here.
interface AppPaths {
  readonly preferencesPath: string
}

class Preference extends TypedEmitter<PreferenceEvents> {
  public readonly preferencesPath: string
  public readonly hasPreferencesFile: boolean
  public readonly store: Store<IUserPreferences>
  public readonly staticPath: string

  /**
   * 内存缓存（P3 主进程热点）。
   *
   * electron-store 底层的 conf 在**每次**读访问（`get(key)` / `store`）时都会
   * `readFileSync` + `JSON.parse` + ajv 对整个文件做 schema 校验（useDefaults）
   * + 顶层对象拷贝——也就是说 `getItem('treePathExcludePatterns')` 这种
   * 「读一个键」的操作，实际代价是「同步读整个偏好文件」。watcher 的每个事件、
   * 菜单与窗口的每次刷新都走这条路，大目录扫描时就是几千次同步读盘、几秒钟的
   * 主线程阻塞。这里把整份偏好缓存在内存里，读路径 O(1)。
   *
   * 一致性：缓存只在**写入成功之后**更新（`store.set` 会先跑 ajv 校验，校验
   * 失败会抛且磁盘不变，此时缓存也必须保持旧值）；批量改写（init 的键集迁移）
   * 通过 `_refreshCache()` 重新取一次快照。除本类外没有其它代码写这个 store。
   */
  private _cache: IUserPreferences

  /**
   * @param paths The path instance.
   *
   * NOTE: This throws an exception when validation fails.
   */
  constructor(paths: AppPaths) {
    // TODO: Preferences should not loaded if global.MARKTEXT_SAFE_MODE is set.
    super()

    const { preferencesPath } = paths
    this.preferencesPath = preferencesPath
    this.hasPreferencesFile = fs.existsSync(
      path.join(this.preferencesPath, `./${PREFERENCES_FILE_NAME}.json`)
    )
    // F1(P0-1)：先迁移再打开 Store —— schema 校验在构造期就会跑。
    migrateLegacyStartUpAction(this.preferencesPath)
    this.store = new Store<IUserPreferences>({
      schema: schema as unknown as Schema<IUserPreferences>,
      name: PREFERENCES_FILE_NAME,
      migrations: {
        '0.18.6': (store) => {
          if (store.get('startUpAction') === 'lastState') {
            store.set('startUpAction', 'openLastFolder')
          }
        }
      },
      beforeEachMigration: (_store, context) => {
        log.info(`Preferences migration: ${context.fromVersion} -> ${context.toVersion}`)
      }
    })

    this.staticPath = path.join(global.__static, 'preference.json')
    // 缓存必须在 init() 之前就绪：init() 会调用 getAll()/getItem()。
    this._cache = this._readStore()
    this.init()
  }

  /** 唯一真实的磁盘读：从 electron-store 取出整份偏好。 */
  private _readStore(): IUserPreferences {
    return this.store.store as IUserPreferences
  }

  /** 批量改写 store 之后重建缓存（写成功才调用）。 */
  private _refreshCache(): void {
    this._cache = this._readStore()
  }

  init = (): void => {
    let defaultSettings: Record<string, unknown> | null = null
    try {
      // 首次启动默认值以 static/preference.json 种子为唯一来源：
      // 不按系统语言/深色主题覆盖（墨记产品默认中文 + claude-light 主题）。
      defaultSettings = JSON.parse(fs.readFileSync(this.staticPath, { encoding: 'utf8' }) || '{}')
    } catch (err) {
      log.error(err)
    }

    if (!defaultSettings) {
      throw new Error('Can not load static preference.json file')
    }

    // I don't know why `this.store.size` is 3 when first load, so I just check file existed.
    if (!this.hasPreferencesFile) {
      this.store.set(defaultSettings)
    } else {
      // Because `this.getAll()` will return a plainObject, so we can not use `hasOwnProperty` method
      // const plainObject = () => Object.create(null)
      const userSetting = this.getAll() as Record<string, unknown>
      // Update outdated settings
      const requiresUpdate = !hasSameKeys(defaultSettings, userSetting)
      const userSettingKeys = Object.keys(userSetting)
      const defaultSettingKeys = Object.keys(defaultSettings)

      if (requiresUpdate) {
        // TODO(fxha): For performance reasons, we should try to replace 'electron-store' because
        //   it does multiple blocking I/O calls when changing entries. There is no transaction or
        //   async I/O available. The core reason we changed to it was JSON scheme validation.

        // Remove outdated settings
        for (const key of userSettingKeys) {
          if (!defaultSettingKeys.includes(key)) {
            delete userSetting[key]
            this.store.delete(key)
          }
        }

        // Add new setting options
        let addedNewEntries = false
        for (const key in defaultSettings) {
          if (!userSettingKeys.includes(key)) {
            addedNewEntries = true
            userSetting[key] = defaultSettings[key]
          }
        }
        if (addedNewEntries) {
          this.store.set(userSetting)
        }
      }
    }

    // 上面几处写入（首启整份写 / 迁移时的 delete 与 set）已落盘，一次性重建缓存。
    // 放在这里也是为了让 `_cache` 与文件内容严格一致：迁移分支是逐键写、中途
    // 可能抛 schema 校验错，逐键同步缓存只会得到半新半旧的中间态。
    this._refreshCache()

    this._listenForIpcMain()
  }

  /**
   * 返回整份偏好的浅拷贝。
   *
   * 与旧实现一致：每次调用都返回一个新对象（conf 的 `store` getter 也是每次新
   * 建并拷贝顶层），调用方改写返回值的顶层键不会影响 store 与缓存。
   */
  getAll(): IUserPreferences {
    return { ...this._cache }
  }

  setItem(key: string, value: unknown): void {
    // 先写盘：schema 校验失败时 `set` 会抛，此时磁盘与缓存都保持旧值（与旧行为
    // 一致——旧实现同样是在 `set` 抛错后既不广播也不更新任何内存态）。
    this.store.set(key, value)
    ;(this._cache as Record<string, unknown>)[key] = value
    ipcMain.emit('broadcast-preferences-changed', { [key]: value })
  }

  getItem<T = unknown>(key: string): T {
    return (this._cache as Record<string, unknown>)[key] as T
  }

  /**
   * Change multiple setting entries.
   *
   * @param settings A settings object or subset object with key/value entries.
   */
  setItems(settings: Record<string, unknown> | null | undefined): void {
    if (!settings) {
      log.error('Cannot change settings without entires: object is undefined or null.')
      return
    }

    Object.keys(settings).forEach((key) => {
      this.setItem(key, settings[key])
    })
  }

  getPreferredEol(): 'lf' | 'crlf' {
    const endOfLine = this.getItem<string>('endOfLine')
    if (endOfLine === 'lf') {
      return 'lf'
    }
    return endOfLine === 'crlf' || isWindows ? 'crlf' : 'lf'
  }

  exportJSON(): void {
    // todo
  }

  importJSON(): void {
    // todo
  }

  _listenForIpcMain(): void {
    ipcMain.on('mt::ask-for-user-preference', (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (win) {
        win.webContents.send('mt::user-preference', this.getAll())
      }
    })
    ipcMain.on('mt::set-user-preference', (_e, settings: Record<string, unknown>) => {
      this.setItems(settings)
    })
    ipcMain.on('mt::cmd-toggle-autosave', () => {
      this.setItem('autoSave', !this.getItem('autoSave'))
    })

    onInternalChannel('set-user-preference', (settings: Record<string, unknown>) => {
      this.setItems(settings)
    })
  }
}

export default Preference
