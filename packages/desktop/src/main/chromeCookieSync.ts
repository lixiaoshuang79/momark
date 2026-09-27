/**
 * Chrome 登录态打通（round11 新功能，用户拍板「输入过的密码不要再输入，
 * 最好打通 Chrome 的数据」）：把 Chrome 的登录 cookie 解密后导入右侧
 * 浏览器面板的 persist:panel 分区——已在 Chrome 登录过的站点在墨记面板
 * 里直接是登录态，无需再次输入密码。
 *
 * ⚠️ 当前状态：**已下线，启动时不再调用**（2026-09-28 代码审查 A-9）。
 *
 *   下线原因：原实现按 Windows 的 GCM 布局解密 macOS 的 v10 密文（直接把
 *   钥匙串口令当 AES key、IV 用「4 空格 + 12 字节 nonce」），对 macOS 的
 *   「PBKDF2-SHA1(1003 轮) + 16 空格 IV + 32 字节 SHA256(host_key) 前缀」
 *   必然解不出正确明文；而 CBC 解密的 PKCS7 填充约有 1/256 的概率碰巧合法，
 *   于是每次启动都会把 1/256 的垃圾值写进 persist:panel——直接覆盖墨记面板
 *   自己的登录态，并且每次启动都弹一次钥匙串授权。
 *
 *   现在的状态：算法已按 macOS 真实格式修正，并且**不覆盖**面板里已存在的
 *   cookie；但**没有**重新挂到启动路径（`browserPanel.ts` 的启动调用已移除），
 *   也没有任何 UI 入口。重新启用需要先定验收方式（见下面「重新启用前」），
 *   否则宁可不跑：一个会写坏登录态的后台任务，比没有这个功能更糟。
 *
 *   重新启用前需要：① 真机验证（装 Chrome、有登录 cookie、比对解密结果与
 *   Chrome 自身行为）；② 给用户一个显式触发入口（手动/一次性，不要每次启动）；
 *   ③ 确认仍未覆盖面板已有 cookie（`skipExisting` 逻辑）。
 *
 * macOS 链路与硬门槛（实测确认）：
 *   1. Chrome 数据目录（~/Library/Application Support/Google/Chrome/*）
 *      受 TCC 保护——读取需要本 app 被授予「完全磁盘访问权限」。
 *      未授权时本模块返回 readable:false，由 browserPanel.ts 弹一次性
 *      引导（打开系统设置的隐私面板），授权后重启 app 即生效。
 *   2. 解密 key = 钥匙串「Chrome Safe Storage」项的口令（security 命令读取，
 *      首次会弹系统钥匙串授权）经 PBKDF2-SHA1(salt='saltysalt', 1003 轮,
 *      16 字节) 派生；cookie 密文格式 v10/v11：
 *      encrypted_value = "v10" + AES-128-CBC(明文, PKCS7)，
 *      iv = 16 个空格；v10 的明文头部还有 32 字节 SHA256(host_key)（v11 无）。
 *      Chrome 127+ 的部分数据改用 App-Bound Encryption，此类 cookie 解密失败
 *      会被静默跳过（不崩溃）。
 *   3. 读取用 node:sqlite（Electron 42 内置 Node ≥ 22.15），先复制
 *      Cookies（含 -wal / -shm 边车文件，否则读不到最近的写入）到临时目录，
 *      避开 Chrome 自身的 SQLite 锁。
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

// macOS Chromium 密钥派生常量（见文件头）。
const CHROME_PBKDF2_SALT = 'saltysalt'
const CHROME_PBKDF2_ITERATIONS = 1003
const CHROME_KEY_BYTES = 16
// v10 明文的头部：SHA256(host_key)，用于确认密钥/主机名都正确。
const V10_HOST_HASH_BYTES = 32

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

/** 钥匙串「Chrome Safe Storage」口令；失败返回 null。 */
const getChromeSafeStoragePassword = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
      { encoding: 'buffer', timeout: 8000, maxBuffer: 1024 }
    )
    const raw = Buffer.from(stdout)
    if (raw.length === 0) return null
    // `security -w` 输出口令 + 换行；口令本身就是密钥材料（不是 base64(key)），
    // 直接当 PBKDF2 口令用。
    const password = raw.toString('utf8').replace(/\r?\n$/, '')
    return password.length > 0 ? password : null
  } catch (error) {
    log.warn('[chromeCookieSync] keychain read failed:', error)
    return null
  }
}

/** 钥匙串口令 → AES-128 key：PBKDF2-SHA1(salt='saltysalt', 1003 轮, 16 字节)。 */
export const deriveChromeCookieKey = (password: string): Buffer =>
  crypto.pbkdf2Sync(
    password,
    CHROME_PBKDF2_SALT,
    CHROME_PBKDF2_ITERATIONS,
    CHROME_KEY_BYTES,
    'sha1'
  )

/**
 * v10/v11 密文解密（Chromium macOS：AES-128-CBC，IV = 16 个空格；v10 明文带
 * 32 字节 SHA256(host_key) 前缀，v11 无）；解密失败或前缀不匹配返回 null。
 */
export const decryptChromeCookieValue = (
  key: Buffer,
  hostKey: string,
  encrypted: Uint8Array
): string | null => {
  try {
    // 3 字节版本标签 + 至少一个 AES 分组。
    if (encrypted.length < 3 + 16) return null
    const version = Buffer.from(encrypted.subarray(0, 3)).toString('latin1')
    if (version !== 'v10' && version !== 'v11') return null
    const ciphertext = Buffer.from(encrypted.subarray(3))
    const iv = Buffer.alloc(16, 0x20)
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    if (version === 'v11') return plaintext.toString('utf8')
    // 前缀是 SHA256(host_key)：用它校验而不是盲目切 32 字节——否则错误的
    // 密钥只要碰巧过 PKCS7（1/256）就会被当成有效值写进面板。
    const prefix = plaintext.subarray(0, V10_HOST_HASH_BYTES)
    const expected = crypto.createHash('sha256').update(hostKey, 'utf8').digest()
    if (!prefix.equals(expected)) return null
    return plaintext.subarray(V10_HOST_HASH_BYTES).toString('utf8')
  } catch {
    return null
  }
}

/**
 * 导入 Chrome cookie 到 persist:panel。任何一步失败都只记录日志、
 * 不抛错（尽力而为的增强功能）。
 *
 * ⚠️ 已下线：**没有调用方**（启动调用见 browserPanel.ts 的说明，已移除）。
 * 算法已修正且不会覆盖面板已有 cookie，但重新启用前请先按文件头的
 * 「重新启用前」清单做真机验证。
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

  const password = await getChromeSafeStoragePassword()
  if (!password) return result
  const key = deriveChromeCookieKey(password)

  // 复制到临时目录读取，避开 Chrome 运行中的 SQLite 锁。WAL 边车文件必须一起
  // 复制（同名 + `-wal`/`-shm`），否则读不到最近写入的 cookie。
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'momark-chrome-cookies-'))
  const copyPath = path.join(tmpDir, 'Cookies')
  let db: ChromeCookieDb | null = null
  try {
    await fsp.copyFile(source, copyPath)
    for (const sidecar of ['-wal', '-shm']) {
      await fsp.copyFile(`${source}${sidecar}`, `${copyPath}${sidecar}`).catch(() => {
        // 不存在（Chrome 已 checkpoint 或未开 WAL）时忽略。
      })
    }
    db = new DatabaseSync(copyPath)
    const rows = db
      .prepare(
        'SELECT host_key, name, encrypted_value, value, expires_utc, is_secure, is_httponly, path FROM cookies'
      )
      .all()
    const nowSec = Date.now() / 1000

    const panelSession = session.fromPartition(BP_PARTITION)
    // 面板自己的登录态优先：只补缺失的 cookie，绝不覆盖已有值。
    const existing = new Set<string>()
    try {
      for (const cookie of await panelSession.cookies.get({})) {
        existing.add(`${cookie.domain}|${cookie.path}|${cookie.name}`)
      }
    } catch (error) {
      log.warn('[chromeCookieSync] cannot list existing panel cookies:', error)
      return result
    }

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
      if (existing.has(`${hostKey}|${row.path || '/'}|${name}`)) {
        result.skipped++
        continue
      }
      let cookieValue: string | null = null
      if (row.encrypted_value) {
        cookieValue = decryptChromeCookieValue(key, hostKey, row.encrypted_value)
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
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
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
