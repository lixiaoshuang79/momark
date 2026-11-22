import { useBrowserPanelStore } from '@/store/browserPanel'
import { useEditorStore } from '@/store/editor'
import { useSplitStore } from '@/store/split'
import type { FileEncoding, HtmlFileDocument, LineEnding } from '@shared/types/files'

/**
 * 「在右侧打开」的共用管线（原 docMode.vue 内部逻辑，feat/right-panel-redesign
 * 抽出来给同目录抽屉的 ⌘↩ / 行内「在右侧打开」复用）：读文件 → 建真实文档标签
 * → 进分屏（左栏保持当前文档）。
 *
 * P0-6：主进程 `bp:readDoc` / `bp:pickDoc` 返回标准打开流程的完整文档
 * （`loadMarkdownFile`：编码探测 + BOM + 换行归一化 + 末尾换行探测），不再
 * 是硬编码的 `encoding:'utf8'/lineEnding:'lf'` —— 那是「GBK 文档在右栏显示
 * 乱码、一保存就把原文件覆盖成乱码」的根因。
 */
export type PanelDocResult = {
  path: string
  pathname: string
  filename: string
  markdown: string
  encoding: FileEncoding
  lineEnding: LineEnding
  adjustLineEndingOnSave: boolean
  trimTrailingNewline: number
  isMixedLineEndings: boolean
}

export type PanelResult = PanelDocResult | ({ kind: 'html' } & HtmlFileDocument)

// round10（用户拍板）：文件已打开也允许进分屏——同一文档左右同开、
// 任一侧编辑另一侧实时同步（allowSame）。
const openFileByPath = async (doc: PanelDocResult): Promise<void> => {
  const editorStore = useEditorStore()
  const splitStore = useSplitStore()
  const bpStore = useBrowserPanelStore()
  const filePath = doc.pathname || doc.path

  // 文件已在标签集合：直接进分屏。若该文档已在右屏（分屏中），
  // 左栏也切到它，实现左右同文档双开。
  const existing = editorStore.tabs.find((t) =>
    window.fileUtils.isSamePathSync(t.pathname, filePath)
  )
  if (existing) {
    bpStore.SET_OPEN(true)
    bpStore.SET_MODE('doc')
    if (splitStore.active && splitStore.tabId === existing.id) {
      editorStore.UPDATE_CURRENT_FILE(existing)
    } else {
      splitStore.DRAG_TO_SPLIT(existing.id, { allowSame: true })
    }
    return
  }

  // 记住打开前的当前文档；全局无当前文档时才让新标签激活（左栏空态）。
  const prev = editorStore.currentFile
  editorStore.NEW_TAB_WITH_CONTENT({
    markdownDocument: {
      markdown: doc.markdown,
      filename: doc.filename || window.path.basename(filePath),
      pathname: filePath,
      // 运行时契约是 `{encoding, isBom}` 对象（见 @shared/types/files.ts
      // 里 `FileEncoding | string` 的说明），`MarkdownDocument.encoding`
      // 声明成 string 是过时描述，故此处断言。
      encoding: doc.encoding as unknown as string,
      lineEnding: doc.lineEnding,
      adjustLineEndingOnSave: doc.adjustLineEndingOnSave,
      trimTrailingNewline: doc.trimTrailingNewline,
      isMixedLineEndings: doc.isMixedLineEndings
    },
    selected: prev == null
  })

  const tab = editorStore.tabs.find((t) => window.fileUtils.isSamePathSync(t.pathname, filePath))
  if (!tab) return

  bpStore.SET_OPEN(true)
  bpStore.SET_MODE('doc')
  splitStore.DRAG_TO_SPLIT(tab.id, { keepCurrent: prev != null })
}

// .html 建只读 html 标签放进分屏（左栏文档不动，即「md + html」左右对照），
// 其余按 Markdown 建编辑标签。
export const openPanelResult = async (result: PanelResult): Promise<void> => {
  const bpStore = useBrowserPanelStore()
  if ('kind' in result && result.kind === 'html') {
    const { pathname, filename, html } = result
    const id = useEditorStore().NEW_HTML_TAB({ doc: { pathname, filename, html }, selected: false })
    bpStore.SET_OPEN(true)
    bpStore.SET_MODE('doc')
    useSplitStore().DRAG_TO_SPLIT(id, { keepCurrent: true, allowSame: true })
    return
  }
  await openFileByPath(result as PanelDocResult)
}

/** 按路径读文件并在右侧分屏打开；读取失败时静默（主进程已就失败原因发过通知）。 */
export const openPathInSplit = async (filePath: string): Promise<boolean> => {
  try {
    const result = (await window.bp.readDoc(filePath)) as PanelResult | null
    if (!result) return false
    await openPanelResult(result)
    return true
  } catch {
    return false
  }
}
