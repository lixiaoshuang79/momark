import os from 'os'
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import log from 'electron-log'

/**
 * IPC 来源校验 + fs 写路径护栏（A-12 的 ③ / ④）。
 *
 * ③ 来源校验：这些通道过去对「谁来调用」毫无要求。渲染层的 preload 只暴露给自家
 * 页面，但 `<webview>` 的 guest（右栏网页，任意第三方站点）同样是 webContents、
 * 同样能发 IPC；沙箱帧 / srcdoc 帧这些子 frame 也在同一个 renderer 里。收紧成
 * **「自家 BrowserWindow 的顶层 frame」**：
 *   - 子 frame 一律拒绝（`senderFrame.parent !== null`）；右栏 webview 的 guest
 *     不是窗口，`BrowserWindow.fromWebContents()` 返回 null，同样被挡在门外；
 *   - 自家窗口的顶层 frame 只可能承载应用自己的渲染层页面：`will-navigate` 已被
 *     browserPanel 全局拦截、`setWindowOpenHandler` 一律 deny（见
 *     `main/browserPanel.ts`），所以无需再比对 URL（比对 URL 反而会在 dev/打包
 *     两条 URL 形态之间埋脆弱的字符串假设）。
 *
 * ④ 写路径护栏：这一批只做**最小可行版本**——把「一次 XSS 就能落地的持久化」
 * 这类目标钉死（LaunchAgents/LaunchDaemons、登录 shell 启动脚本、~/.ssh），外加
 * 应用自身 bundle（自篡改）。完整的「允许路径集合」（用户显式打开/保存过的路径 +
 * 项目目录）需要把菜单/对话框的路径状态穿到 fs 通道，牵涉 `main/app/**` 与
 * `main/menu/**`，见批次 4 报告的后续设计。
 */

// ── ③ 来源校验 ────────────────────────────────────────────────────────

/**
 * 是否来自「自家窗口的顶层 frame」。webview guest、子 frame、已销毁窗口一律 false。
 */
export const isTrustedIpcSender = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
  const frame = event.senderFrame
  if (!frame) return false
  // 只认顶层 frame：子 frame 可能是 srcdoc / 沙箱帧 / 被嵌入的第三方文档。
  if (frame.parent !== null) return false
  const win = BrowserWindow.fromWebContents(event.sender)
  // webview guest 不是 BrowserWindow（返回 null），右栏网页因此被拒。
  return !!win && !win.isDestroyed()
}

export const UNTRUSTED_SENDER_MESSAGE = 'blocked: IPC sender is not an app window main frame'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown
type EventHandler = (event: IpcMainEvent, ...args: never[]) => void

/** `ipcMain.handle` + 来源校验（不可信来源 → 拒绝 Promise）。 */
export const trustedHandle = (channel: string, handler: InvokeHandler): void => {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcSender(event)) {
      log.warn(`[ipc] refused ${channel} from untrusted sender`)
      throw new Error(UNTRUSTED_SENDER_MESSAGE)
    }
    return handler(event, ...(args as never[]))
  })
}

/** `ipcMain.on` + 来源校验（不可信来源 → 丢弃）。 */
export const trustedOn = (channel: string, handler: EventHandler): void => {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedIpcSender(event)) {
      log.warn(`[ipc] dropped ${channel} from untrusted sender`)
      return
    }
    handler(event, ...(args as never[]))
  })
}

// ── ④ fs 写路径护栏 ───────────────────────────────────────────────────

/** 禁止写入的目录（含其内部任意层级）。 */
const deniedWriteDirs = (): string[] => {
  const home = os.homedir()
  return [
    // macOS 持久化主通道：丢一个 plist 进去，下次登录就跑代码。
    path.join(home, 'Library', 'LaunchAgents'),
    path.join(home, 'Library', 'LaunchDaemons'),
    '/Library/LaunchAgents',
    '/Library/LaunchDaemons',
    // Linux 桌面自启。
    path.join(home, '.config', 'autostart'),
    // 凭据目录。
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    // 系统配置目录（正常使用不会写；写也需要 root）。
    '/etc',
    '/System',
    '/usr',
    '/bin',
    '/sbin',
    // 应用自身：防自篡改（asar 内的代码/资源）。
    process.resourcesPath,
    app.getAppPath()
  ].filter(Boolean)
}

/** 禁止覆写的单个文件（登录 shell 启动脚本同样是持久化入口）。 */
const deniedWriteFiles = (): string[] => {
  const home = os.homedir()
  return [
    '.zshrc',
    '.zprofile',
    '.zshenv',
    '.zlogin',
    '.bashrc',
    '.bash_profile',
    '.bash_login',
    '.profile'
  ].map((name) => path.join(home, name))
}

/** 规范化：绝对化 + 去尾斜杠（不做 realpath——不引入 IO，也不跟随符号链接）。 */
const normalizeForCheck = (p: string): string => {
  const resolved = path.resolve(p)
  return resolved.length > 1 ? resolved.replace(/[/\\]+$/, '') : resolved
}

/**
 * 写类操作的目标路径是否被护栏拒绝。只拦「写/删/移动/新建目录」这类会落地文件
 * 的操作；读操作不在这一批（见文件头的后续设计说明）。
 */
export const isDeniedWritePath = (target: unknown): boolean => {
  if (typeof target !== 'string' || !target.trim()) return true
  if (target.includes('\0')) return true
  const normalized = normalizeForCheck(target)
  const lower =
    process.platform === 'darwin' || process.platform === 'win32'
      ? normalized.toLowerCase()
      : normalized
  for (const file of deniedWriteFiles()) {
    if (lower === file.toLowerCase()) return true
  }
  for (const dir of deniedWriteDirs()) {
    const d =
      process.platform === 'darwin' || process.platform === 'win32'
        ? normalizeForCheck(dir).toLowerCase()
        : normalizeForCheck(dir)
    if (lower === d || lower.startsWith(`${d}${path.sep}`)) return true
  }
  return false
}

/**
 * 校验一组写路径；任一被拒即返回拒绝原因，调用方按「拒绝并记日志」处理。
 * 传 `null`/`undefined` 的槽位跳过（例如 `move` 的 dest 缺省）。
 */
export const checkWritePaths = (...targets: unknown[]): string | null => {
  for (const target of targets) {
    if (target === undefined || target === null) continue
    if (isDeniedWritePath(target)) return String(target)
  }
  return null
}
