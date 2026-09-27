import { ipcMain, shell, clipboard } from 'electron'
import log from 'electron-log'
import * as plist from 'plist'
import { isDangerousExecutableFile, isExecutableFile } from 'common/filesystem/paths'

// F1(A-11)：渲染层可以给 `mt::shell::open-external` 传任意字符串，主进程原样交给
// 系统——恶意文档里的链接（或一次 XSS）能拿它拉起任意 scheme handler。只放行
// 联网/邮件三类，其余一律拒绝。
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

// 例外：Chrome 登录态导入的「完全磁盘访问」引导要打开系统设置的安全面板
// （见 renderer store/notification.ts）。它不是文档可控输入，但也只放行
// 安全面板这一个前缀，不给任意 x-apple.* 深链开闸。
const ALLOWED_SYSTEM_SETTINGS_PREFIX = 'x-apple.systempreferences:com.apple.preference.security'

/**
 * 是否允许交给 `shell.openExternal`。只看 scheme，不做任何网络/内容判断：
 * `javascript:`、`file:`、`data:`、自定义 handler 一概拒绝。
 */
export const isAllowedExternalUrl = (url: unknown): boolean => {
  if (typeof url !== 'string' || !url.trim()) {
    return false
  }
  if (url.startsWith(ALLOWED_SYSTEM_SETTINGS_PREFIX)) {
    return true
  }
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * F1(A-11)：`shell.openPath` 对可执行文件是「运行」而不是「打开」。扩展名黑名单
 * （含 `.terminal`/`.workflow`/`.pkg`）加上可执行位兜住无扩展名的可执行文件；
 * 目录不在拦截范围（对目录它是打开访达）。
 */
export const isBlockedOpenPath = (fullPath: unknown): boolean => {
  if (typeof fullPath !== 'string' || !fullPath.trim()) {
    return true
  }
  return isDangerousExecutableFile(fullPath) || isExecutableFile(fullPath)
}

export const registerShellHandlers = (): void => {
  ipcMain.handle('mt::shell::open-external', async (_e, url: string) => {
    if (!isAllowedExternalUrl(url)) {
      log.warn('shell.openExternal refused (scheme not allowed):', url)
      return false
    }
    try {
      await shell.openExternal(url)
      return true
    } catch (err) {
      log.error('shell.openExternal failed:', err)
      return false
    }
  })
  ipcMain.on('mt::shell::open-external', (_e, url: string) => {
    if (!isAllowedExternalUrl(url)) {
      log.warn('shell.openExternal refused (scheme not allowed):', url)
      return
    }
    shell.openExternal(url).catch((err) => log.error('shell.openExternal failed:', err))
  })
  ipcMain.on('mt::shell::show-item', (_e, fullPath: string) => {
    try {
      shell.showItemInFolder(fullPath)
    } catch (err) {
      log.error('shell.showItemInFolder failed:', err)
    }
  })
  ipcMain.handle('mt::shell::open-path', async (_e, fullPath: string) => {
    if (isBlockedOpenPath(fullPath)) {
      log.warn('shell.openPath refused (executable path):', fullPath)
      return 'Blocked: refusing to open an executable file'
    }
    try {
      return await shell.openPath(fullPath)
    } catch (err) {
      log.error('shell.openPath failed:', err)
      return String(err instanceof Error ? err.message : err)
    }
  })

  ipcMain.on('mt::clipboard::write-text', (_e, text: string) => {
    try {
      clipboard.writeText(text)
    } catch (err) {
      log.error('clipboard.writeText failed:', err)
    }
  })
  ipcMain.handle('mt::clipboard::read-text', () => {
    try {
      return clipboard.readText()
    } catch {
      return ''
    }
  })

  ipcMain.handle('mt::clipboard::guess-file-path', () => {
    try {
      if (process.platform === 'darwin') {
        if (clipboard.has('NSFilenamesPboardType')) {
          const parsed = plist.parse(clipboard.read('NSFilenamesPboardType'))
          return Array.isArray(parsed) && parsed.length ? parsed[0] : ''
        }
        return ''
      }
      if (process.platform === 'win32') {
        // `FileNameW` is a UTF-16LE, NUL-separated list of file paths.
        // `clipboard.read(format)` decodes the raw bytes as UTF-8, which garbles
        // non-ASCII (e.g. Chinese) characters; read the Buffer and decode it as
        // UTF-16LE instead, then take the first non-empty entry.
        const buffer = clipboard.readBuffer('FileNameW')
        if (buffer.length > 0) {
          return (
            buffer
              .toString('utf16le')
              .split('\u0000')
              .find((p) => p.length > 0) ?? ''
          )
        }
        return ''
      }
      return ''
    } catch (err) {
      log.error('clipboard.guess-file-path failed:', err)
      return ''
    }
  })
}
