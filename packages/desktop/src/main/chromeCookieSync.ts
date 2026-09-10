/**
 * Chrome 登录态打通（round11 新功能，用户拍板「输入过的密码不要再输入，
 * 最好打通 Chrome 的数据」）：把 Chrome 的登录 cookie 解密后导入右侧
 * 浏览器面板的 persist:panel 分区——已在 Chrome 登录过的站点在墨记面板
 * 里直接是登录态，无需再次输入密码。
 *
 * macOS 链路与硬门槛（实测确认）：
 *   1. Chrome 数据目录（~/Library/Application Support/Google/Chrome/*）
 *      受 TCC 保护——读取需要本 app 被授予「完全磁盘访问权限」。
 *      未授权时本模块返回 readable:false，由 browserPanel.ts 弹一次性
 *      引导（打开系统设置的隐私面板），授权后重启 app 即生效。
 *   2. 解密 key = 钥匙串「Chrome Safe Storage」项（security 命令读取，
 *      首次会弹系统钥匙串授权）；cookie 密文格式 v10：
 *      encrypted_value = "v10" + nonce(12B) + AES-128-CBC(明文, PKCS7)，
 *      iv = 32 个空格 + nonce。Chrome 127+ 的部分数据改用 App-Bound
 *      Encryption，此类 cookie 解密失败会被静默跳过（不崩溃）。
 *   3. 读取用 node:sqlite（Electron 42 内置 Node ≥ 22.15），先复制
 *      Cookies 文件到临时目录避开 Chrome 自身的 SQLite 锁。
 */

import { app, session } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import log from 'electron-log'
import { BP_PARTITION } from './browserPanel'

const execFileAsync = promisify(execFile)

// node:sqlite 动态加载：构建环境 Node ≥ 22.5 内置；不可用则整体静默降级。
interface ChromeCookieRow {
  host_key: string
  name: string
  encrypted_value: Uint8Array | null
  value: string | null
  expires_utc: number
  is_secure: number
  is_httponly: number
  path: string
}

interface ChromeCookieDb {
  prepare(sql: string): {
    all(): ChromeCookieRow[]
  }
  close(): void
}

type DatabaseSyncCtor = new (file: string) => ChromeCookieDb

let DatabaseSync: DatabaseSyncCtor | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseSync = require('node:sqlite').DatabaseSync as DatabaseSyncCtor
} catch {
  DatabaseSync = null
}

const CHROME_BASE = (): string =>
  path.join(app.getPath('home'), 'Library', 'Application Support', 'Google', 'Chrome')

const CHROME_COOKIE_CANDIDATES = (): string[] => {
  const base = CHROME_BASE()
  return [
    path.join(base, 'Default', 'Network', 'Cookies'),
    ...Array.from({ length: 6 }, (_, i) =>
      path.join(base, `Profile ${i + 1}`, 'Network', 'Cookies')
    )
  ]
}

// 第一次导入失败时是否已弹过授权引导（userData 标志文件，弹过一次不再打扰）。
const GUIDE_FLAG = (): string => path.join(app.getPath('userData'), 'chrome-cookies-guide-shown')

export interface ChromeCookieImportResult {
  readable: boolean
  imported: number
  skipped: number
}

/** 首个可读的 Chrome Cookies 文件路径；全部不可读（TCC/不存在）返回 null。 */
export const findChromeCookiesFile = async (): Promise<string | null> => {
  for (const candidate of CHROME_COOKIE_CANDIDATES()) {
    try {
      await fsp.access(candidate, fs.constants.R_OK)
      return candidate
    } catch {
      // TCC 拒绝或文件不存在，继续探测下一个 profile。
    }
  }
  return null
}

/**
 * 探测 Chrome 数据可读性（供渲染层就绪后拉取引导状态）。
 * macOS TCC 实测：无权访问时 Chrome 目录本身报 EPERM、深层 Cookies 路径被
 * 混淆为 ENOENT——因此以「Chrome 目录」为判定点：
 *   readable=true —— Cookies 可读，可直接导入；
 *   exists=true 且 readable=false —— Chrome 已装但被 TCC 挡住（引导授权）；
 *   exists=false —— 未安装 Chrome（不引导，静默）。
 */
export const probeChromeCookies = async (): Promise<{ readable: boolean; exists: boolean }> => {
  try {
    await fsp.access(CHROME_BASE(), fs.constants.R_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { readable: false, exists: code !== 'ENOENT' }
  }
  const file = await findChromeCookiesFile()
  if (file) return { readable: true, exists: true }
  // Chrome 目录可读但找不到 Cookies：profile 缺失（罕见），不引导。
  return { readable: false, exists: false }
}

/** 钥匙串「Chrome Safe Storage」→ 16 字节 AES key；失败返回 null。 */
const getChromeSafeStorageKey = async (): Promise<Buffer | null> => {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
      { encoding: 'buffer', timeout: 8000, maxBuffer: 1024 }
    )
    const raw = Buffer.from(stdout)
    if (raw.length === 0) return null
    // 新 Chrome 存 base64(16B)；旧版可能存原始 16B。分别适配。
    const text = raw.toString('utf8').trim()
    if (/^[A-Za-z0-9+/]{22}={0,2}$/.test(text)) {
      const decoded = Buffer.from(text, 'base64')
      if (decoded.length === 16) return decoded
    }
    return raw.length >= 16 ? raw.subarray(0, 16) : null
  } catch (error) {
    log.warn('[chromeCookieSync] keychain read failed:', error)
    return null
  }
}

/** v10 密文解密（Chromium aes_128_cbc：IV = 4 空格 + 12 字节 nonce）；失败返回 null。 */
const decryptV10 = (key: Buffer, encrypted: Uint8Array): string | null => {
  try {
    if (
      encrypted.length < 18 ||
      Buffer.from(encrypted.subarray(0, 3)).toString('latin1') !== 'v10'
    ) {
      return null
    }
    const nonce = Buffer.from(encrypted.subarray(3, 15))
    const ciphertext = Buffer.from(encrypted.subarray(15))
    const iv = Buffer.concat([Buffer.alloc(4, 0x20), nonce])
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * 导入 Chrome cookie 到 persist:panel。任何一步失败都只记录日志、
 * 不抛错（尽力而为的增强功能）。
 */
export const tryImportChromeCookies = async (): Promise<ChromeCookieImportResult> => {
  const result: ChromeCookieImportResult = { readable: false, imported: 0, skipped: 0 }
  if (!DatabaseSync) {
    log.warn('[chromeCookieSync] node:sqlite unavailable, import disabled')
    return result
  }

  const source = await findChromeCookiesFile()
  if (!source) return result
  result.readable = true

  const key = await getChromeSafeStorageKey()
  if (!key) return result

  // 复制到临时目录读取，避开 Chrome 运行中的 SQLite 锁。
  const copyPath = path.join(os.tmpdir(), `momark-chrome-cookies-${Date.now()}.sqlite`)
  let db: ChromeCookieDb | null = null
  try {
    await fsp.copyFile(source, copyPath)
    db = new DatabaseSync(copyPath)
    const rows = db
      .prepare(
        'SELECT host_key, name, encrypted_value, value, expires_utc, is_secure, is_httponly, path FROM cookies'
      )
      .all()
    const nowSec = Date.now() / 1000

    const panelSession = session.fromPartition(BP_PARTITION)
    for (const row of rows) {
      const hostKey = typeof row.host_key === 'string' ? row.host_key : ''
      const name = typeof row.name === 'string' ? row.name : ''
      if (!hostKey || !name) {
        result.skipped++
        continue
      }
      const expirationSec = row.expires_utc > 0 ? row.expires_utc / 1e6 - 11644473600 : 0
      if (expirationSec > 0 && expirationSec < nowSec) {
        result.skipped++
        continue
      }
      let cookieValue: string | null = null
      if (row.encrypted_value) {
        cookieValue = decryptV10(key, row.encrypted_value)
      } else if (typeof row.value === 'string' && row.value) {
        cookieValue = row.value
      }
      if (!cookieValue) {
        result.skipped++
        continue
      }
      const host = hostKey.startsWith('.') ? hostKey.slice(1) : hostKey
      try {
        await panelSession.cookies.set({
          url: `${row.is_secure ? 'https' : 'http'}://${host}${row.path || '/'}`,
          name,
          value: cookieValue,
          domain: hostKey,
          path: row.path || '/',
          secure: !!row.is_secure,
          httpOnly: !!row.is_httponly,
          expirationDate: expirationSec > 0 ? expirationSec : undefined
        })
        result.imported++
      } catch {
        result.skipped++
      }
    }
    log.info(`[chromeCookieSync] imported ${result.imported}, skipped ${result.skipped}`)
  } catch (error) {
    log.warn('[chromeCookieSync] import failed:', error)
  } finally {
    try {
      db?.close()
    } catch {
      // 忽略关闭错误
    }
    fsp.unlink(copyPath).catch(() => {})
  }
  return result
}

/** 是否已弹过 FDA 授权引导（弹过一次即不再打扰）。 */
export const hasShownChromeCookieGuide = (): boolean => {
  try {
    return fs.existsSync(GUIDE_FLAG())
  } catch {
    return false
  }
}

export const markChromeCookieGuideShown = (): void => {
  try {
    fs.writeFileSync(GUIDE_FLAG(), new Date().toISOString())
  } catch (error) {
    log.warn('[chromeCookieSync] write guide flag failed:', error)
  }
}

/**
 * 渲染层就绪后的拉取式引导状态：
 * Chrome 数据存在但被 TCC 挡住、且从未引导过 → shouldShow=true。
 * （首启是欢迎页、无 #/editor 窗口，主进程推式发送会丢失，故改 pull。）
 */
export const getChromeCookieGuideState = async (): Promise<{ shouldShow: boolean }> => {
  if (hasShownChromeCookieGuide()) return { shouldShow: false }
  const probe = await probeChromeCookies()
  return { shouldShow: probe.exists && !probe.readable }
}
