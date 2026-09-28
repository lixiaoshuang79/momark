import { app, shell } from 'electron'
import log from 'electron-log'
import type { IUpdateInfo, IUpdateProgress } from '@shared/types/ipc'
import { checkForUpdates, downloadUpdate, extractUpdate, installUpdate } from '../updater'
import { trustedHandle } from './guard'

/**
 * 应用自动更新（feat/updater）的 IPC 通道。
 *
 * 三条链路：查最新版（`mt::update-check`）→ 下载并解压（`mt::update-download`，
 * 进度经 `mt::update-progress` 事件回推）→ 提权安装并重启（`mt::update-install`）。
 * 另有一条兜底：`mt::update-open-release` 用系统浏览器打开 release 页（自动安装
 * 走不通时用户仍有出路）。
 */

export const registerUpdaterHandlers = (): void => {
  trustedHandle('mt::update-check', async () => {
    return checkForUpdates()
  })

  trustedHandle('mt::update-download', async (event, info: IUpdateInfo) => {
    const zipPath = await downloadUpdate(info, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('mt::update-progress', {
          phase: 'download',
          received: progress.received,
          total: progress.total
        } satisfies IUpdateProgress)
      }
    })

    if (!event.sender.isDestroyed()) {
      event.sender.send('mt::update-progress', {
        phase: 'extract',
        received: 0,
        total: 0
      } satisfies IUpdateProgress)
    }

    const appPath = await extractUpdate(zipPath)

    return { appPath }
  })

  trustedHandle('mt::update-install', async (_event, appPath: string) => {
    try {
      await installUpdate(appPath)
    } catch (error) {
      log.error('[updater] install failed:', error)
      throw error
    }

    // 安装脚本会在本进程退出后替换 app 并 `open` 新版本；这里主动退出，
    // 让脚本的 `while pgrep` 能等到进程消失。
    setTimeout(() => app.quit(), 300)

    return { ok: true }
  })

  trustedHandle('mt::update-open-release', async () => {
    await shell.openExternal('https://github.com/lixiaoshuang79/momark/releases/latest')

    return { ok: true }
  })
}
