import fs from 'fs'
import os from 'os'
import path from 'path'
import { exec } from 'child_process'
import { app, net } from 'electron'
import log from 'electron-log'
import type { IUpdateCheckResult, IUpdateInfo } from '@shared/types/ipc'

/**
 * 应用自动更新（feat/updater）。
 *
 * 数据源是发布仓的 GitHub Release（`momark/<x.y.z>` tag，附件里带
 * `momark-mac-arm64-<ver>.zip`）。三步：查最新版 → 下载 zip（带进度）→
 * 提权替换 /Applications 里的 app 并重启。
 *
 * 为什么不用 electron-updater：macOS 上它的自动安装（Squirrel.Mac）**要求
 * 应用经过代码签名**，墨记当前未签名/未公证，走它只会在安装环节失败。
 * 自己实现 = 解压 + `cp -R` + `xattr -cr`（去掉下载隔离属性，免 Gatekeeper
 * 拦截），与本项目「用户手动 xattr -cr」的既有说明一致。
 */

const RELEASE_REPO = 'lixiaoshuang79/momark'
const LATEST_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`

/** 下载进度的回调载荷（进程内部用，跨进程的形状见 `IUpdateProgress`）。 */
export interface IDownloadProgress {
  received: number
  total: number
}

/** `momark/1.5.1` → `1.5.1`（也兼容裸 `v1.5.1` / `1.5.1` 的写法）。 */
const parseVersion = (tag: string): string =>
  tag
    .replace(/^momark\//, '')
    .replace(/^v/, '')
    .trim()

/** 语义化版本比较：a 比 b 新才返回 true（只比数字段，预发布后缀忽略）。 */
const isNewer = (a: string, b: string): boolean => {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)

  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0

    if (x !== y) return x > y
  }

  return false
}

/** 查 GitHub 上的最新 release 并和当前版本比对。任何失败都归到 `error`，不抛。 */
export const checkForUpdates = async (): Promise<IUpdateCheckResult> => {
  const current = app.getVersion()

  try {
    const res = await net.fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MoMark-Updater' }
    })

    if (!res.ok) {
      log.warn(`[updater] check failed: HTTP ${res.status}`)

      return { hasUpdate: false, current, info: null, error: `HTTP ${res.status}` }
    }

    const data = (await res.json()) as {
      tag_name?: string
      body?: string
      published_at?: string
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>
    }

    const tagName = String(data.tag_name ?? '')
    const version = parseVersion(tagName)

    if (!version) {
      return { hasUpdate: false, current, info: null, error: 'release 缺少可识别的 tag' }
    }

    // 只认 macOS arm64 的 zip：dmg 无法在本进程内解压，zip 才能自动安装。
    const asset = (data.assets ?? []).find(
      (a) => typeof a.name === 'string' && a.name.endsWith('.zip') && a.name.includes('arm64')
    )

    const info: IUpdateInfo = {
      version,
      tagName,
      notes: String(data.body ?? ''),
      publishedAt: String(data.published_at ?? ''),
      assetUrl: asset?.browser_download_url ?? null,
      assetName: asset?.name ?? null,
      assetSize: typeof asset?.size === 'number' ? asset.size : null
    }

    return { hasUpdate: isNewer(version, current), current, info }
  } catch (error) {
    log.warn('[updater] check threw:', error)

    return { hasUpdate: false, current, info: null, error: String(error) }
  }
}

/**
 * 下载更新包到 `userData/updates/`，返回本地路径。
 *
 * 用 `net.fetch` 而不是 Node 的 https：它走 Electron 的网络栈（系统代理、
 * 证书策略与页面一致），大文件在弱网下也按块回调进度。
 */
export const downloadUpdate = async (
  info: IUpdateInfo,
  onProgress: (progress: IDownloadProgress) => void
): Promise<string> => {
  if (!info.assetUrl || !info.assetName) throw new Error('该 release 没有 mac arm64 的 zip 附件')

  const dir = path.join(app.getPath('userData'), 'updates')
  await fs.promises.mkdir(dir, { recursive: true })
  const target = path.join(dir, info.assetName)

  const res = await net.fetch(info.assetUrl, { headers: { 'User-Agent': 'MoMark-Updater' } })

  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length')) || info.assetSize || 0
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let received = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    chunks.push(chunk)
    received += chunk.length
    onProgress({ received, total })
  }

  await fs.promises.writeFile(target, Buffer.concat(chunks))
  log.info(`[updater] downloaded ${target} (${received} bytes)`)

  return target
}

/**
 * 解压 zip 到临时目录，返回解压出的 `.app` 路径。
 *
 * 用 `ditto -x -k` 而不是 unzip：ditto 保留 bundle 里的符号链接与扩展属性
 * （Electron 的 Framework 里有 symlink，unzip 会解开成副本，撑爆体积且可能
 * 破坏签名结构）。
 */
export const extractUpdate = async (zipPath: string): Promise<string> => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'momark-update-'))
  await new Promise<void>((resolve, reject) => {
    exec(`ditto -x -k ${JSON.stringify(zipPath)} ${JSON.stringify(dir)}`, (error) => {
      if (error) reject(new Error(`解压失败：${error.message}`))
      else resolve()
    })
  })

  const entries = await fs.promises.readdir(dir)
  const appName = entries.find((name) => name.endsWith('.app'))

  if (!appName) throw new Error('压缩包里没有 .app')

  return path.join(dir, appName)
}

/**
 * 提权安装：用 `osascript ... with administrator privileges` 跑一段 shell，
 * 等墨记退出 → 替换目标 app → `xattr -cr` → 重启。
 *
 * 为什么要等退出：替换正在运行的 bundle，macOS 允许 unlink，但进程仍在用旧
 * 文件，重启前新旧混杂；等进程真正退出再换最干净。脚本里 `open` 负责用户
 * 看到的那一步「更新完自动打开」。
 *
 * 提权是必需的：`/Applications` 属主是 root，普通用户不能直接替换。这也是
 * 用户拍板「全自动替换」时接受的唯一打扰（每次更新弹一次系统密码框）。
 */
export const installUpdate = async (extractedAppPath: string): Promise<void> => {
  // 当前运行的 app bundle（…/墨记.app）；开发态（electron-vite dev）没有这个
  // 层级，installUpdate 只对打包产物有意义。
  const appBundle = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '')
  const targetApp = appBundle.endsWith('.app') ? appBundle : '/Applications/墨记.app'

  const script = [
    'set -e',
    `while pgrep -f ${JSON.stringify(targetApp)} > /dev/null 2>&1; do sleep 0.5; done`,
    `rm -rf ${JSON.stringify(targetApp)}`,
    `ditto ${JSON.stringify(extractedAppPath)} ${JSON.stringify(targetApp)}`,
    `xattr -cr ${JSON.stringify(targetApp)}`,
    `open ${JSON.stringify(targetApp)}`
  ].join('; ')

  log.info('[updater] installing to', targetApp)

  await new Promise<void>((resolve, reject) => {
    // osascript 的字符串里同时含单双引号，这里统一走双引号并转义内层双引号。
    const escaped = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    exec(
      `osascript -e "do shell script \\"${escaped}\\" with administrator privileges"`,
      (error) => {
        if (error) reject(new Error(`安装失败：${error.message}`))
        else resolve()
      }
    )
  })
}
