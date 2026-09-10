import template from './index.html?raw'
import { getUniqueId } from '../../util'
import { sanitize, EXPORT_DOMPURIFY_CONFIG } from '../../util/dompurify'
import { t } from '../../i18n'
import './index.css'

export type NotificationType = 'primary' | 'error' | 'warning' | 'info'

const INON_HASH: Record<NotificationType, string> = {
  primary: 'icon-message',
  error: 'icon-error',
  warning: 'icon-warn',
  info: 'icon-info'
}
const TYPE_HASH: Record<NotificationType, string> = {
  primary: 'mt-primary',
  error: 'mt-error',
  warning: 'mt-warning',
  info: 'mt-info'
}

const fillTemplate = (
  type: NotificationType,
  title: string,
  message: string,
  confirmText: string
): string => {
  return template
    .replace(/\{\{icon\}\}/, INON_HASH[type])
    .replace(/\{\{title\}\}/, sanitize(title, EXPORT_DOMPURIFY_CONFIG))
    .replace(/\{\{message\}\}/, sanitize(message, EXPORT_DOMPURIFY_CONFIG))
    .replace(/\{\{confirmText\}\}/, sanitize(confirmText, EXPORT_DOMPURIFY_CONFIG))
}

export interface NotifyOptions {
  time?: number
  title?: string
  message?: string
  type?: NotificationType
  showConfirm?: boolean
}

interface NoticeCacheEntry {
  remove: () => void
}

interface NotificationService {
  name: string
  noticeCache: Record<string, NoticeCacheEntry>
  clear(): void
  notify(opts: NotifyOptions): Promise<void>
}

const notification: NotificationService = {
  name: 'notify',
  noticeCache: {} as Record<string, NoticeCacheEntry>,
  clear() {
    Object.keys(this.noticeCache).forEach((key) => {
      this.noticeCache[key].remove()
    })
  },
  notify({
    time = 4000,
    title = '',
    message = '',
    type = 'primary', // primary, error, warning or info
    showConfirm = false
  }: NotifyOptions): Promise<void> {
    let rs: (() => void) | undefined
    let rj: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    const id = getUniqueId()

    const fragment = document.createElement('div')
    fragment.innerHTML = fillTemplate(type, title, message, t('notifications.confirm'))

    const noticeContainer = fragment.querySelector('.mt-notification') as HTMLElement
    const confirm = noticeContainer.querySelector('.confirm') as HTMLElement
    const close = noticeContainer.querySelector('.close') as HTMLElement
    let target: HTMLElement = noticeContainer

    if (showConfirm) {
      noticeContainer.classList.add('mt-confirm')
      target = confirm
    }

    noticeContainer.classList.add(TYPE_HASH[type])

    const setCloseTimer = (): void => {
      if (!showConfirm && typeof time === 'number' && time > 0) {
        timer = setTimeout(() => {
          remove()
        }, time)
      }
    }

    const clickHandler = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      remove()
      if (rs) rs()
    }

    const closeHandler = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      remove()
      if (rj) rj()
    }

    const rePositionNotices = (): void => {
      const notices = document.querySelectorAll('.mt-notification')
      let offset = 0
      const len = notices.length
      for (let i = 0; i < len; i++) {
        const el = notices[i] as HTMLElement
        el.style.top = `${14 + offset}px`
        el.style.zIndex = String(10000 - i)
        offset += el.offsetHeight + 8
      }
    }

    const remove = (): void => {
      if (timer) clearTimeout(timer)
      noticeContainer.classList.add('mt-toast-out')

      window.setTimeout(() => {
        target.removeEventListener('click', clickHandler)
        close.removeEventListener('click', closeHandler)
        noticeContainer.remove()
        rePositionNotices()
        if (notification.noticeCache[id]) {
          delete notification.noticeCache[id]
        }
      }, 180)
    }

    notification.noticeCache[id] = { remove }

    target.addEventListener('click', clickHandler)
    close.addEventListener('click', closeHandler)

    window.setTimeout(rePositionNotices, 50)
    setCloseTimer()

    document.body.prepend(noticeContainer, document.body.firstChild as Node)

    return new Promise<void>((resolve, reject) => {
      rs = resolve
      rj = reject
    })
  }
}

export default notification
