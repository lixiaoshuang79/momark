import { defineStore } from 'pinia'
import notice, { type NotifyOptions } from '../services/notification'
import { t } from '../i18n'

export const useNotificationStore = defineStore('notification', () => {
  function listenForNotification(): void {
    const DEFAULT_OPTS = {
      title: t('notifications.defaultTitle'),
      type: 'primary' as const,
      time: 10000,
      message: t('notifications.defaultMessage')
    }

    window.electron.ipcRenderer.on('mt::show-notification', (_e, opts) => {
      const options = Object.assign({ ...DEFAULT_OPTS }, opts as Partial<NotifyOptions>)
      notice.notify(options)
    })

    window.electron.ipcRenderer.on('mt::pandoc-not-exists', async (_e, opts) => {
      // Preserve the custom title/message from main (e.g. dialog.importWarning
      // / dialog.installPandoc / docx 导出缺 pandoc 的 brew 指引); previously
      // the opts arg was dropped and the user saw the generic defaultTitle /
      // defaultMessage.
      const { openDocs, ...rest } = (opts ?? {}) as Partial<NotifyOptions> & {
        openDocs?: boolean
      }
      const options: NotifyOptions = Object.assign({ ...DEFAULT_OPTS }, rest, {
        showConfirm: true
      })
      await notice.notify(options)
      // 导入路径引导到 pandoc.org；docx 导出路径只展示 brew 指引，不跳外链。
      if (openDocs) {
        window.electron.shell.openExternal('http://pandoc.org')
      }
    })
  }

  return { listenForNotification }
})
