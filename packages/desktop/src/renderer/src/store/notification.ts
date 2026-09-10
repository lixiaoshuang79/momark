import { defineStore } from 'pinia'
import { watch } from 'vue'
import notice, { type NotifyOptions } from '../services/notification'
import { t, i18n } from '../i18n'

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

    // round11：Chrome 登录态导入的 FDA 授权引导（一次性，拉取式——首启是
    // 欢迎页，主进程推式发送会丢）。确认后打开系统设置的「完全磁盘访问」
    // 面板，用户勾选墨记后重启 app 即生效。
    // 语言经 mt::user-preference 异步切换，启动瞬间弹会显示英文——等 locale
    // 离开默认 en 再弹，1.5s 兜底（纯英文用户/加载失败也不丢引导）。
    let guideFired = false
    let stopLocaleWatch: (() => void) | null = null
    const fireChromeCookieGuide = (): void => {
      if (guideFired) return
      guideFired = true
      stopLocaleWatch?.()
      window.electron.ipcRenderer
        .invoke('bp:chrome-cookie-guide-state')
        .then((state) => {
          if (!state?.shouldShow) return
          const options: NotifyOptions = {
            title: t('notifications.chromeCookieGuideTitle'),
            message: t('notifications.chromeCookieGuideMessage'),
            type: 'warning',
            showConfirm: true
          }
          notice
            .notify(options)
            .then(() => {
              window.electron.ipcRenderer.send('mt::chrome-cookie-guide-mark-shown')
              window.electron.shell.openExternal(
                'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
              )
            })
            .catch(() => {})
        })
        .catch(() => {})
    }
    if (i18n.global.locale.value === 'en') {
      stopLocaleWatch = watch(
        () => i18n.global.locale.value,
        (value) => {
          if (value !== 'en') fireChromeCookieGuide()
        }
      )
    }
    window.setTimeout(fireChromeCookieGuide, 1500)
  }

  return { listenForNotification }
})
