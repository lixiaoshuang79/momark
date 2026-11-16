import notice from '@/services/notification'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { useEditorStore } from '@/store/editor'
import { useSplitStore } from '@/store/split'
import type { HtmlFileDocument } from '@shared/types/files'
import { t } from '../i18n'

/**
 * 编辑器 HTML 块的两个「出口」：左编辑器与右栏分屏编辑器共用，
 * 由引擎事件 `muya-html-open-side-by-side` / `muya-html-save-as-file` 触发。
 * 两者都落成一张 html 标签放进分屏——它就是普通标签，可以拖回标签栏、再拖进分屏。
 */

export interface HtmlBlockSideBySidePayload {
  title: string
  html: string
}

const openSideBySide = (doc: HtmlFileDocument, extra: { title?: string; origin?: string } = {}) => {
  const id = useEditorStore().NEW_HTML_TAB({ doc, selected: false, ...extra })
  useSplitStore().DRAG_TO_SPLIT(id, { keepCurrent: true })
  // 标注 tab 压在面板上时让位：用户刚要求看这张页面。
  useBrowserPanelStore().SET_TAB('doc')
}

/** 「并列查看」：块源码做成一张没有路径的快照标签，左边文档不动。 */
export const openHtmlBlockSideBySide = (
  payload: HtmlBlockSideBySidePayload,
  docFilename: string
): void => {
  const title = payload.title || 'HTML'
  openSideBySide(
    { pathname: '', filename: title, html: payload.html },
    { title, origin: docFilename }
  )
}

// 大体积 HTML 块「另存为 .html 文件…」：主进程弹保存框写盘，写好后把这个文件作为
// 标签打开、放进分屏，直接进入「md + html」左右对照。
export const saveHtmlBlockAsFile = async (
  payload: { title: string; html: string },
  docPathname: string | null
): Promise<void> => {
  const doc = await window.electron.ipcRenderer.invoke('mt::html::save-as', {
    html: payload.html,
    title: payload.title,
    docPathname
  })
  if (!doc) return
  notice.notify({
    message: t('editor.htmlFile.saved', { name: doc.filename }),
    type: 'primary',
    time: 2500
  })
  openSideBySide(doc)
}
