import { markRaw, shallowReactive } from 'vue'
import { defineStore } from 'pinia'
import notice from '@/services/notification'
import type { HtmlFileDocument } from '@shared/types/files'
import { t } from '../i18n'
import { describeMissedResources, inlineHtmlForPreview } from '../util/htmlInline'

export interface HtmlTabSource {
  /** 投进沙箱帧的源码：带路径的文件已把同目录 CSS / JS / 图片内联进来。 */
  html: string
  pathname: string
  /** 内嵌块快照来自哪篇文档（文件名），供标签悬停提示。 */
  origin: string
  /** 每次换源码加一；视图把它拼进 iframe 的 key，换源码即换帧。 */
  revision: number
}

/**
 * 只读 html 标签的页面源码，按标签 id 存放。
 *
 * 不放进标签状态：单个 HTML 最大 32MB，进了 `editorStore.tabs` 就会被响应式代理、
 * 进崩溃恢复缓冲快照、走 IPC 结构化克隆。这里只有 Map 本身是响应式的，条目是
 * markRaw 的不可变对象，换源码 = 换条目。
 */
export const useHtmlTabsStore = defineStore('htmlTabs', () => {
  const sources = shallowReactive(new Map<string, HtmlTabSource>())
  let revisionSeq = 0

  // 同一标签连续两次载入（打开后马上点「重新载入」）时，只认最后一次的结果。
  const pending = new Map<string, number>()

  /**
   * 记下标签的源码。有路径时先内联同目录资源（沙箱帧是不透明源，读不到 file://），
   * 内联不全如实提示；内嵌块快照（没有路径）原样使用。
   */
  async function SET_SOURCE(id: string, doc: HtmlFileDocument, origin = ''): Promise<void> {
    const ticket = ++revisionSeq
    pending.set(id, ticket)
    let html = doc.html
    if (doc.pathname) {
      try {
        const result = await inlineHtmlForPreview(doc.html, doc.pathname)
        html = result.html
        if (result.missed.length) {
          notice.notify({
            message: t('editor.htmlFile.missed', {
              count: result.missed.length,
              reasons: describeMissedResources(result.missed)
            }),
            type: 'warning',
            time: 3000
          })
        }
      } catch (error) {
        console.error('[html-tab] inline resources failed:', error)
      }
    }
    if (pending.get(id) !== ticket) return
    pending.delete(id)
    sources.set(id, markRaw({ html, pathname: doc.pathname, origin, revision: ticket }))
  }

  /** 外部改了文件：按原路径重新读盘，读不到时主进程已发过通知，页面保持原样。 */
  async function RELOAD(id: string): Promise<void> {
    const pathname = sources.get(id)?.pathname
    if (!pathname) return
    const doc = await window.electron.ipcRenderer.invoke('mt::html::read', pathname)
    const current = sources.get(id)
    if (doc && current) await SET_SOURCE(id, doc, current.origin)
  }

  function DROP(id: string): void {
    pending.delete(id)
    sources.delete(id)
  }

  return { sources, SET_SOURCE, RELOAD, DROP }
})
