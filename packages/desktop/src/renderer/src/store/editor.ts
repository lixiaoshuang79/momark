import equal from 'deep-equal'
import bus from '../bus'
import { getUniqueId, deepClone } from '../util'
import listToTree, { type ListItem, type TreeNode } from '../util/listToTree'
import {
  createDocumentState,
  getOptionsFromState,
  getBlankFileState,
  defaultFileState
} from './help'
import notice from '../services/notification'
import {
  FileEncodingCommand,
  LineEndingCommand,
  QuickOpenCommand,
  TrailingNewlineCommand
} from '../commands'
import { defineStore } from 'pinia'
import { useAnnotationStore } from './annotation'
import { usePreferencesStore } from './preferences'
import { useProjectStore } from './project'
import { useLayoutStore } from './layout'
import { useSplitStore } from './split'
import { useWorkspaceStore } from './workspace'
import { useMainStore } from '.'
import { t } from '../i18n'
import { debouncedSendBufferedState, sendBufferedState } from './bufferedState'
import type {
  IFileState,
  FileNotification,
  LineEnding,
  MarkdownDocument,
  PageOptions,
  TabOptions
} from '@shared/types/files'

// ----------------------------------------------------------------------------
// Local helper types
// ----------------------------------------------------------------------------

interface TocItem extends ListItem {
  slug?: string
  githubSlug?: string
  content?: string
  lvl: number | null
}

type TocTreeNode = TreeNode<TocItem>

interface RestoreWarning {
  tabId?: string | null
  pathname?: string
  msg: string
  showConfirm?: boolean
  style?: string
  exclusiveType?: string
}

interface PushTabNotificationPayload {
  tabId: string
  msg: string
  showConfirm?: boolean
  style?: string
  exclusiveType?: string
  action?: FileNotification['action']
}

interface FileChangePayload {
  pathname: string
  data: {
    isMixedLineEndings?: boolean
    lineEnding?: LineEnding | string
    adjustLineEndingOnSave?: boolean
    trimTrailingNewline?: number
    encoding?: IFileState['encoding']
    markdown: string
    filename: string
  }
}

interface FormatLinkClickPayload {
  // muya's getLinkInfo yields `href: null` when the rendered link carries no
  // usable href (e.g. an unsupported protocol stripped by sanitizeHyperlink).
  data: { href: string | null; [key: string]: unknown }
  dirname: string
}

interface ExportPayload {
  type: string
  content?: string
  pageOptions?: PageOptions
  headerTemplate?: string
  footerTemplate?: string
}

interface AutoSavePayload {
  id: string
  filename: string
  pathname: string
  markdown: string
  options: ReturnType<typeof getOptionsFromState>
}

interface ContentChangePayload {
  id: string
  markdown: string
  wordCount?: IFileState['wordCount']
  cursor?: unknown
  muyaIndexCursor?: unknown
  history?: IFileState['history']
  toc?: TocItem[]
  blocks?: unknown
}

interface AffiliationEntry {
  type: string
  functionType?: string
  listType?: string
  listItemType?: string
  isLooseListItem?: boolean
  [key: string]: unknown
}

interface SelectionChange {
  start: {
    key: string
    offset: number
    block?: { text?: string; functionType?: string }
    type?: string
  }
  end: { key: string; offset: number; block?: { functionType?: string }; type?: string }
  affiliation?: AffiliationEntry[]
  hasFrontMatter?: boolean
}

interface SelectionFormat {
  type: string
  [key: string]: unknown
}

interface ProjectStoreLike {
  projectTree: { pathname?: string } | null
}

// ----------------------------------------------------------------------------
// State shape
// ----------------------------------------------------------------------------

export interface EditorState {
  currentFile: IFileState | null
  tabs: IFileState[]
  tabIdToIndex: Record<string, number>
  listToc: TocItem[]
  toc: TocTreeNode[]
}

const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const useEditorStore = defineStore('editor', {
  state: (): EditorState => ({
    currentFile: null,
    tabs: [],
    tabIdToIndex: {},
    listToc: [], // Used for equal check and for searching for the correct github-slug to jump to
    toc: []
  }),

  actions: {
    updateTabIdToIndex(): void {
      this.tabIdToIndex = this.tabs.reduce<Record<string, number>>((map, tab, index) => {
        map[tab.id] = index
        return map
      }, {})
    },

    CREATE_BUFFERED_STATE(): ReturnType<typeof createBufferedEditorState> {
      return createBufferedEditorState(this.$state)
    },

    RESTORE_BUFFERED_STATE(state: unknown): void {
      const rawState = state as { editor?: unknown; project?: unknown; layout?: unknown } | null
      const editorInput = rawState?.editor ?? state
      const bufferedEditorState = createBufferedEditorState(editorInput)
      if (!bufferedEditorState) {
        console.error('RESTORE_BUFFERED_STATE: Invalid editor buffer state.')
        return
      }

      const oldIdToNewId: Record<string, string> = {}
      const tabs: IFileState[] = bufferedEditorState.tabs.map((tab) => {
        const fileState = createDocumentState(tab as unknown as Record<string, unknown>)
        oldIdToNewId[tab.id] = fileState.id
        return fileState
      })

      const currentFileId = bufferedEditorState.currentFileId
        ? oldIdToNewId[bufferedEditorState.currentFileId]
        : undefined
      const currentFile: IFileState | null = tabs.find((tab) => tab.id === currentFileId) ?? null

      const projectStore = useProjectStore()
      const layoutStore = useLayoutStore()

      projectStore.RESTORE_BUFFERED_STATE(rawState?.project)
      layoutStore.RESTORE_BUFFERED_STATE(rawState?.layout)
      this.$patch((s) => {
        s.tabs = tabs
        s.currentFile = currentFile
        s.tabIdToIndex = {}
        s.listToc = []
        s.toc = []
      })

      this.updateTabIdToIndex()
      window.DIRNAME = currentFile?.pathname ? window.path.dirname(currentFile.pathname) : ''
      this.UPDATE_LINE_ENDING_MENU()

      for (const warning of bufferedEditorState.restoreWarnings) {
        const restoredTabId = warning.tabId ? oldIdToNewId[warning.tabId] : null
        const tab = restoredTabId
          ? this.tabs.find((t) => t.id === restoredTabId)
          : this.tabs.find((t) =>
              window.fileUtils.isSamePathSync(t.pathname, warning.pathname ?? '')
            )

        if (!tab) continue

        this.pushTabNotification({
          tabId: tab.id,
          msg: warning.msg,
          showConfirm: warning.showConfirm,
          style: warning.style,
          exclusiveType: warning.exclusiveType
        })
      }
    },

    /**
     * Copies the specified heading's github-slug to the clipboard.
     * @param key The heading-id to copy.
     */
    copyGithubSlug(key: string): void {
      const item = this.listToc.find((i) => i.slug === key)

      if (item) {
        window.electron.clipboard.writeText(`#${item.githubSlug}`)
        notice.notify({
          title: t('store.editor.anchorLinkCopied'),
          type: 'primary',
          time: 2000,
          showConfirm: false
        })
      } else {
        console.warn(t('store.editor.tocItemNotFound', { key }))
      }
    },

    /**
     * Update scroll position for the currentFile
     */
    updateScrollPosition(id: string, scrollTop: number): void {
      if (!(id in this.tabIdToIndex)) {
        console.warn('updateScrollPosition: Cannot find tab index for id:', id)
        return
      }

      const tab = this.tabs[this.tabIdToIndex[id]]
      if (tab) {
        tab.scrollTop = scrollTop
      }
      debouncedSendBufferedState()
    },

    /**
     * Push a tab specific notification on stack that never disappears.
     */
    pushTabNotification(data: PushTabNotificationPayload): void {
      const defaultAction: FileNotification['action'] = () => {}
      const { tabId, msg } = data
      const action = data.action || defaultAction
      const showConfirm = data.showConfirm || false
      const style = data.style || 'info'
      // Whether only one notification should exist.
      const exclusiveType = data.exclusiveType || ''

      const tab = this.tabs.find((t) => t.id === tabId)
      if (!tab) {
        console.error(t('store.editor.tabNotFound'))
        return
      }

      const { notifications } = tab

      // Remove the old notification if only one should exist.
      if (exclusiveType) {
        const index = notifications.findIndex((n) => n.exclusiveType === exclusiveType)
        if (index >= 0) {
          // Reorder current notification
          notifications.splice(index, 1)
        }
      }

      // Push new notification on stack.
      notifications.push({
        msg,
        showConfirm,
        style,
        exclusiveType,
        action
      })
    },

    loadChange(change: FileChangePayload): void {
      const { tabs, currentFile } = this
      const { data, pathname } = change
      const {
        isMixedLineEndings,
        lineEnding,
        adjustLineEndingOnSave,
        trimTrailingNewline,
        encoding,
        markdown,
        filename
      } = data
      // Create a new document and update few entires later.
      const newFileState = createDocumentState({
        markdown,
        filename,
        pathname,
        encoding,
        lineEnding,
        adjustLineEndingOnSave,
        trimTrailingNewline
      })

      const tab = tabs.find((t) => window.fileUtils.isSamePathSync(t.pathname, pathname))
      if (!tab) {
        // The tab may be closed in the meanwhile.
        console.error('loadChange: Cannot find tab in tab list.')
        notice.notify({
          title: t('store.editor.errorLoadingTabTitle'),
          message: t('store.editor.errorLoadingTabMessage'),
          type: 'error',
          time: 20000,
          showConfirm: false
        })
        return
      }

      // Backup few entries that we need to restore later.
      const oldId = tab.id
      const oldNotifications = tab.notifications
      // Preserve scroll across external reload so the editor stays put.
      const oldScrollTop = tab.scrollTop
      let oldHistory: IFileState['history'] | null = null
      const histIndex = tab.history.index
      if (histIndex >= 0 && tab.history.stack.length >= 1) {
        const entry = tab.history.stack[histIndex]
        if (entry) {
          // Allow to restore the old document.
          oldHistory = {
            stack: [entry],
            index: 0
          }
        }

        // Free reference from array
        tab.history.index--
        tab.history.stack.pop()
      }

      // Update file content and restore some entries.
      Object.assign(tab, newFileState)
      tab.id = oldId
      tab.notifications = oldNotifications
      tab.scrollTop = oldScrollTop
      if (oldHistory) {
        tab.history = oldHistory
      }

      if (isMixedLineEndings && typeof lineEnding === 'string') {
        this.pushTabNotification({
          tabId: tab.id,
          msg: t('store.editor.mixedLineEndingsNormalized', {
            name: filename,
            lineEnding: lineEnding.toUpperCase()
          }),
          showConfirm: false,
          style: 'info',
          exclusiveType: ''
        })
      }

      // Reload the editor if the tab is currently opened.
      if (currentFile && pathname === currentFile.pathname) {
        // save current state first
        this.currentFile = tab
        const { id, cursor, history, scrollTop, muyaIndexCursor } = tab // Should not use blocks history as this is loaded from disk
        bus.emit('file-changed', {
          id,
          markdown,
          muyaIndexCursor,
          cursor,
          renderCursor: true,
          history,
          scrollTop,
          // External disk reload: the engine handler records the new content as a
          // single invertible undo boundary (replaceContent) instead of clearing
          // history (setContent), so the first undo restores the pre-reload doc.
          isReload: true
        })
        // 外部重载后正文全变了：把标注表重新推给引擎做一次全量重定位 + 核对
        // （方案 §5.5 / 契约 C：`mt::update-file` 重载完成后触发）。
        // 延一帧——引擎的 replaceContent 是异步的，紧接着推会按旧 state 定位。
        window.setTimeout(() => {
          const annotationStore = useAnnotationStore()
          annotationStore.syncFromEngine()
          annotationStore.pushToEngine()
        }, 0)
      }
      debouncedSendBufferedState()
    },

    FORMAT_LINK_CLICK({ data, dirname }: FormatLinkClickPayload): void {
      // Check if the link starts with a #, that is a local anchor link.
      if (data.href && data.href[0] === '#') {
        const anchorSlug = data.href.substring(1)
        if (!anchorSlug) return

        // Find the block with the anchor slug from the TOC
        for (const item of this.listToc) {
          if (item.githubSlug === anchorSlug) {
            // Scroll to the corresponding element that matches this github-slug
            bus.emit('scroll-to-header', item.slug)
            return
          }
        }

        // Fall back to a non-heading target: a custom `<a id="...">` (or any
        // element with a matching id) rendered in the document.
        const anchorElement = document.getElementById(anchorSlug)
        if (anchorElement) {
          bus.emit('scroll-to-anchor-element', anchorElement)
        }

        return
      }

      window.electron.ipcRenderer.send('mt::format-link-click', { data, dirname })
    },

    LISTEN_SCREEN_SHOT(): void {
      window.electron.ipcRenderer.on('mt::screenshot-captured', (_, filePath) => {
        bus.emit('screenshot-captured', filePath)
      })
    },

    // image path auto complement
    ASK_FOR_IMAGE_AUTO_PATH(src: string): Promise<string[]> {
      if (!this.currentFile) return Promise.resolve([])
      const { pathname } = this.currentFile
      if (pathname) {
        let rs: (value: string[]) => void = () => {}
        const promise = new Promise<string[]>((resolve) => {
          rs = resolve
        })
        const id = getUniqueId()
        // Dynamic IPC channel — not part of the static IpcMainEventChannels contract.
        ;(
          window.electron.ipcRenderer.once as (
            channel: string,
            listener: (event: unknown, files: string[]) => void
          ) => void
        )(`mt::response-of-image-path-${id}`, (_: unknown, files: string[]) => {
          rs(files)
        })
        window.electron.ipcRenderer.send('mt::ask-for-image-auto-path', {
          pathname,
          src,
          id,
          currentFile: deepClone(this.currentFile)
        })
        return promise
      } else {
        return Promise.resolve([])
      }
    },

    SEARCH(value: IFileState['searchMatches']): void {
      if (!this.currentFile) return
      this.currentFile.searchMatches = deepClone(value) // deep clone to trigger state changes
    },

    SHOW_IMAGE_DELETION_URL(deletionUrl: string): void {
      notice
        .notify({
          title: t('store.editor.imageDeletionUrlTitle'),
          message: t('store.editor.imageDeletionUrlMessage', { url: deletionUrl }),
          showConfirm: true,
          time: 20000
        })
        .then(() => {
          window.electron.clipboard.writeText(deletionUrl)
        })
    },

    // We need to update line endings menu when changing tabs.
    UPDATE_LINE_ENDING_MENU(): void {
      if (!this.currentFile) return
      const { lineEnding } = this.currentFile
      if (lineEnding) {
        const { windowId } = window.marktext?.env ?? { windowId: -1 }
        window.electron.ipcRenderer.send(
          'mt::update-line-ending-menu',
          windowId,
          lineEnding as LineEnding
        )
      }
    },

    // Flush any edit still queued in the engine's rAF batch into the active
    // tab's `currentFile` before its markdown is read to persist — otherwise an
    // edit made in the same frame as the read is silently dropped from the
    // written file (#3803), the way tab switching already guards (#2938). Safe
    // no-op when nothing is pending.
    flushActiveEditor(): void {
      bus.emit('flush-active-editor')
    },

    /**
     * F1(P0-4)：保存回执对账。
     *
     * 主进程把「发起保存时登记的内容版本」原样带回（`mt::tab-saved` /
     * `mt::set-pathname` 的 `version`）。只有回执版本 === 当前内容版本，才说明
     * 写下去的就是此刻屏幕上的内容，此时才置 clean；写盘期间用户又改了内容
     * （版本已推进）时必须**保持脏**——否则那段输入既不会被自动保存带上
     * （`HANDLE_AUTO_SAVE` 只在 `!isSaved` 时发请求），也不会在关窗时被提示
     * （P0-1），等于永不落盘。
     *
     * `version` 缺省（重命名/移动目录走的老通道）时退化为旧行为。
     */
    APPLY_SAVE_RECEIPT(tab: IFileState, version?: number): void {
      const currentVersion = getSaveVersion(tab)
      if (typeof version !== 'number' || version === currentVersion) {
        if (currentVersion >= 0) {
          tab.lastSavedHistoryId = currentVersion
        }
        tab.isSaved = true
        return
      }

      // 磁盘上的是旧版本，标签仍然是脏的。
      tab.isSaved = false

      // 开了自动保存时补一次：这一次写盘期间的输入否则要等到用户下一次敲键
      // 才会被重新排上（LISTEN_FOR_CONTENT_CHANGE 是唯一布防点）。收敛性由
      // 版本对账保证——保存不改内容，下一轮回执必然一致。
      const preferencesStore = usePreferencesStore()
      if (preferencesStore.autoSave && tab.pathname) {
        this.HANDLE_AUTO_SAVE({
          id: tab.id,
          filename: tab.filename,
          pathname: tab.pathname,
          markdown: tab.markdown,
          options: getOptionsFromState(tab)
        })
      }
    },

    FILE_SAVE(): void {
      this.flushActiveEditor()
      const projectStore = useProjectStore()
      const target = this.getSaveTarget()
      if (!target) return
      const { id, filename, pathname, markdown } = target
      const options = getOptionsFromState(target)
      const defaultPath = getRootFolderFromState(projectStore)
      if (id) {
        window.electron.ipcRenderer.send(
          'mt::response-file-save',
          id,
          filename,
          pathname,
          markdown,
          deepClone(options),
          defaultPath,
          // F1(P0-4)：登记本次写盘对应的内容版本，主进程原样回传。
          getSaveVersion(target)
        )
      }
    },

    // Cmd+S 保存目标：光标在右侧分屏文档编辑器时保存右侧文档，
    // 否则保存左侧当前文档（round：右栏编辑可直接保存，无需拖回左边）。
    getSaveTarget(): IFileState | null {
      const splitStore = useSplitStore()
      const workspaceStore = useWorkspaceStore()
      if (splitStore.active && splitStore.kind === 'doc' && splitStore.docFocused) {
        const splitTab = workspaceStore.splitDocTab
        if (splitTab) return splitTab
      }
      return this.currentFile ?? null
    },

    // need pass some data to main process when `save` menu item clicked
    LISTEN_FOR_SAVE(): void {
      window.electron.ipcRenderer.on('mt::editor-ask-file-save', () => {
        this.FILE_SAVE()
      })
      bus.on('mt::editor-ask-file-save', () => {
        this.FILE_SAVE()
      })
    },

    FILE_SAVE_AS(): void {
      this.flushActiveEditor()
      const projectStore = useProjectStore()
      const target = this.getSaveTarget()
      if (!target) return
      const { id, filename, pathname, markdown } = target
      const options = getOptionsFromState(target)
      const defaultPath = getRootFolderFromState(projectStore)

      if (id) {
        window.electron.ipcRenderer.send(
          'mt::response-file-save-as',
          id,
          filename,
          pathname,
          markdown,
          deepClone(options),
          defaultPath,
          // F1(P0-4)：登记本次写盘对应的内容版本，主进程原样回传。
          getSaveVersion(target)
        )
      }
    },

    // need pass some data to main process when `save as` menu item clicked
    LISTEN_FOR_SAVE_AS(): void {
      window.electron.ipcRenderer.on('mt::editor-ask-file-save-as', () => {
        this.FILE_SAVE_AS()
      })
      bus.on('mt::editor-ask-file-save-as', () => {
        this.FILE_SAVE_AS()
      })
    },

    LISTEN_FOR_SET_PATHNAME(): void {
      window.electron.ipcRenderer.on('mt::set-pathname', (_, fileInfo) => {
        const { tabs } = this
        const { pathname, id } = fileInfo
        const tab = tabs.find((f) => f.id === id)
        if (!tab) {
          console.error('[ERROR] Cannot change file path from unknown tab.')
          return
        }

        // If a tab with the same file path already exists we need to close the tab.
        // The existing tab is overwritten by this tab.
        const existingTab = tabs.find(
          (t) => t.id !== id && window.fileUtils.isSamePathSync(t.pathname, pathname)
        )
        if (existingTab) {
          this.CLOSE_TAB(existingTab)
        }

        // SET_PATHNAME
        const { filename } = fileInfo
        if (id === this.currentFile?.id && pathname) {
          window.DIRNAME = window.path.dirname(pathname)
        }
        if (tab) {
          // 另存为 / 首次保存：标注跟着路径走（旧路径的标注文件搬到新 key 下，
          // 未保存文档的内存标注落到新路径）。必须拿改路径之前的 pathname。
          const previousPathname = tab.pathname
          Object.assign(tab, { filename, pathname })
          // F1(P0-4)：`mt::set-pathname` 也是「保存已落盘」的回执（主进程写完
          // 才发），同样要按版本对账——写盘期间的输入不能被它顺手置成 clean。
          // 重命名/移动到新目录走的也是这条通道，不带版本，按旧行为处理。
          this.APPLY_SAVE_RECEIPT(tab, fileInfo.version)
          if (previousPathname !== pathname) {
            const annotationStore = useAnnotationStore()
            if (previousPathname) {
              annotationStore.MIGRATE_PATH({ from: previousPathname, to: pathname })
            } else {
              annotationStore.ADOPT_PATH({ tabId: id, pathname })
            }
          }
          debouncedSendBufferedState()
        }
      })

      window.electron.ipcRenderer.on('mt::tab-saved', (_, tabId, version) => {
        const tab = this.tabs.find((f) => f.id === tabId)
        if (tab) {
          // F1(P0-4)：按登记的内容版本对账（见 APPLY_SAVE_RECEIPT），
          // 版本一致才置 clean——原来无条件拿「回执到达那一刻」的
          // lastEditIndex 当已保存版本，写盘 IO 期间的输入会被一起标记成
          // 已保存：自动保存跳过它（HANDLE_AUTO_SAVE 查 isSaved），关窗也
          // 不提示（P0-1），这段输入永不落盘。
          this.APPLY_SAVE_RECEIPT(tab, version)
          // 保存成功：未保存文档的标注从内存 key 迁到文件路径 key 并落盘。
          if (tab.pathname) {
            useAnnotationStore().ADOPT_PATH({ tabId, pathname: tab.pathname })
          }
          debouncedSendBufferedState()
        }
      })

      window.electron.ipcRenderer.on('mt::tab-save-failure', (_, tabId, msg) => {
        const tab = this.tabs.find((t) => t.id === tabId)
        if (!tab) {
          notice.notify({
            title: t('dialog.saveFailure'),
            message: msg,
            type: 'error',
            time: 20000,
            showConfirm: false
          })
          return
        }

        tab.isSaved = false
        this.pushTabNotification({
          tabId,
          msg: t('store.editor.errorWhileSaving', { msg }),
          style: 'crit'
        })
        debouncedSendBufferedState()
      })
    },

    LISTEN_FOR_CLOSE(): void {
      const projectStore = useProjectStore()
      window.electron.ipcRenderer.on('mt::ask-for-close', () => {
        // F1(B-26)：关窗前先把引擎 rAF 批里最后一次编辑落进 tab（#3803 同源问题：
        // 读 `isSaved`/`markdown` 前不 flush，这一帧的输入既不会被算作未保存、
        // 也不会被写盘，静默丢）。同步拿到的才是最新内容，所以放在读之前、
        // 也放在 buffer 快照之前。
        this.flushActiveEditor()

        sendBufferedState()
          .catch((err) => {
            console.error('Failed to update buffered state before closing', err)
          })
          .then(() => {
            const unsavedFiles = this.tabs
              .filter((file) => !file.isSaved)
              .map((file) => {
                const { id, filename, pathname, markdown } = file
                const options = getOptionsFromState(file)
                return {
                  id,
                  filename,
                  pathname,
                  markdown,
                  options,
                  defaultPath: getRootFolderFromState(projectStore),
                  // F1(P0-4)：内容版本随请求走，主进程回执原样带回。
                  version: getSaveVersion(file)
                }
              })

            // F1(P0-1)：只要有未保存的标签就弹保存确认，不再有 `restoreAll` 豁免。
            // 「反正会被恢复」的前提已不成立：主进程的恢复分支早已移除
            // （见 src/main/app/index.ts），被豁免的内容只留在永不被读取的
            // buffer JSON 里＝静默丢弃；`restoreAll` 也已从 schema/默认值清理
            // （老用户已存的值在 preferences 侧迁移为 blank）。
            if (unsavedFiles.length) {
              window.electron.ipcRenderer.send('mt::close-window-confirm', deepClone(unsavedFiles))
            } else {
              window.electron.ipcRenderer.send('mt::close-window')
            }
          })
      })
    },

    LISTEN_FOR_SAVE_CLOSE(): void {
      window.electron.ipcRenderer.on('mt::force-close-tabs-by-id', (_, tabIdList) => {
        if (Array.isArray(tabIdList) && tabIdList.length) {
          this.CLOSE_TABS(tabIdList)
        }
      })
    },

    ASK_FOR_SAVE_ALL(closeTabs: boolean): void {
      const { tabs } = this
      const projectStore = useProjectStore()
      // F1(B-26)：保存/关闭前先落进引擎批里的最后一次编辑（同 LISTEN_FOR_CLOSE）。
      this.flushActiveEditor()
      const unsavedFiles = tabs
        .filter((file) => !(file.isSaved && /[^\n]/.test(file.markdown)))
        .map((file) => {
          const { id, filename, pathname, markdown } = file
          const options = getOptionsFromState(file)
          return {
            id,
            filename,
            pathname,
            markdown,
            options,
            defaultPath: getRootFolderFromState(projectStore),
            // F1(P0-4)：内容版本随请求走，主进程回执原样带回。
            version: getSaveVersion(file)
          }
        })

      if (closeTabs) {
        if (unsavedFiles.length) {
          this.CLOSE_TABS(tabs.filter((f) => f.isSaved).map((f) => f.id))
          window.electron.ipcRenderer.send('mt::save-and-close-tabs', deepClone(unsavedFiles))
        } else {
          this.CLOSE_TABS(tabs.map((f) => f.id))
        }
      } else {
        window.electron.ipcRenderer.send('mt::save-tabs', deepClone(unsavedFiles))
      }
    },

    MOVE_FILE_TO(): void {
      if (!this.currentFile) return
      this.flushActiveEditor()
      const projectStore = useProjectStore()
      const { id, filename, pathname, markdown } = this.currentFile
      const options = getOptionsFromState(this.currentFile)
      const defaultPath = getRootFolderFromState(projectStore)
      if (!id) return
      if (!pathname) {
        // if current file is a newly created file, just save it!
        window.electron.ipcRenderer.send(
          'mt::response-file-save',
          id,
          filename,
          pathname,
          markdown,
          deepClone(options),
          defaultPath,
          // F1(P0-4)：登记本次写盘对应的内容版本，主进程原样回传。
          getSaveVersion(this.currentFile)
        )
      } else {
        // if not, move to a new(maybe) folder
        window.electron.ipcRenderer.send('mt::response-file-move-to', { id, pathname })
      }
    },

    LISTEN_FOR_MOVE_TO(): void {
      window.electron.ipcRenderer.on('mt::editor-move-file', () => {
        this.MOVE_FILE_TO()
      })
      bus.on('mt::editor-move-file', () => {
        this.MOVE_FILE_TO()
      })
    },

    LISTEN_FOR_RENAME(): void {
      window.electron.ipcRenderer.on('mt::editor-rename-file', () => {
        this.RESPONSE_FOR_RENAME()
      })
      bus.on('mt::editor-rename-file', () => {
        this.RESPONSE_FOR_RENAME()
      })
    },

    RESPONSE_FOR_RENAME(): void {
      if (!this.currentFile) return
      this.flushActiveEditor()
      const projectStore = useProjectStore()
      const { id, filename, pathname, markdown } = this.currentFile
      const options = getOptionsFromState(this.currentFile)
      const defaultPath = getRootFolderFromState(projectStore)
      if (!id) return
      if (!pathname) {
        // if current file is a newly created file, just save it!
        window.electron.ipcRenderer.send(
          'mt::response-file-save',
          id,
          filename,
          pathname,
          markdown,
          deepClone(options),
          defaultPath,
          // F1(P0-4)：登记本次写盘对应的内容版本，主进程原样回传。
          getSaveVersion(this.currentFile)
        )
      } else {
        bus.emit('rename')
      }
    },

    // ask for main process to rename this file to a new name `newFilename`
    RENAME(newFilename: string): void {
      if (!this.currentFile) return
      const { id, pathname, filename } = this.currentFile
      if (typeof filename === 'string' && filename !== newFilename) {
        const newPathname = window.path.join(window.path.dirname(pathname), newFilename)
        window.electron.ipcRenderer.send('mt::rename', {
          id,
          pathname,
          newPathname,
          currentFile: deepClone(this.currentFile)
        })
      }
    },

    /**
     * Update the pathname/filename of any tab whose pathname matches `src`.
     * Invoked from the sidebar rename flow (project.ts:RENAME_IN_SIDEBAR).
     */
    RENAME_IF_NEEDED({ src, dest }: { src: string; dest: string }): void {
      this.tabs.forEach((tab) => {
        if (tab.pathname === src) {
          tab.pathname = dest
          tab.filename = window.path.basename(dest)
        }
      })
      // Keep DIRNAME in sync when the active tab is the one being renamed,
      // so link resolution / dirname-based lookups don't keep using the old
      // folder until the user switches tabs.
      if (this.currentFile != null && this.currentFile.pathname === dest) {
        window.DIRNAME = window.path.dirname(dest)
      }
      debouncedSendBufferedState()
    },

    UPDATE_CURRENT_FILE(currentFile: IFileState): void {
      const oldCurrentFile = this.currentFile
      let didUpdateCurrentFile = false
      if (oldCurrentFile == null || oldCurrentFile.id !== currentFile.id) {
        const { id, markdown, cursor, history, pathname, scrollTop, blocks, muyaIndexCursor } =
          currentFile
        // Must run while `currentFile` still points at the outgoing tab, so its
        // flushed edit is attributed to that tab and not lost on switch (#2938).
        if (oldCurrentFile) {
          this.flushActiveEditor()
        }
        window.DIRNAME = pathname ? window.path.dirname(pathname) : ''
        this.currentFile = currentFile
        didUpdateCurrentFile = true

        if (!this.tabs.some((file) => file.id === currentFile.id)) {
          this.tabs.push(currentFile)
          this.updateTabIdToIndex()
        }

        bus.emit('file-changed', {
          id,
          markdown,
          cursor,
          muyaIndexCursor,
          renderCursor: true,
          history,
          scrollTop,
          blocks
        })

        // 标注只认主编辑区的主文档（方案 §3.6）：换了标签就切标注上下文——
        // 先把旧文件的标注 flush 落盘，再装载新文件的表并推给引擎。
        useAnnotationStore().SWITCH_DOC({ pathname, tabId: id })
      }

      this.UPDATE_LINE_ENDING_MENU()
      if (didUpdateCurrentFile) {
        debouncedSendBufferedState()
      }
    },

    // This events are only used during window creation.
    LISTEN_FOR_BOOTSTRAP_WINDOW(): void {
      const preferencesStore = usePreferencesStore()
      const layoutStore = useLayoutStore()
      const projectStore = useProjectStore()
      const mainStore = useMainStore()

      // Delay load runtime commands and initialize commands.
      setTimeout(() => {
        bus.emit('cmd::register-command', new FileEncodingCommand(this))
        bus.emit(
          'cmd::register-command',
          new QuickOpenCommand({
            editor: this,
            preferences: preferencesStore,
            project: projectStore
          })
        )
        bus.emit('cmd::register-command', new LineEndingCommand(this))
        bus.emit('cmd::register-command', new TrailingNewlineCommand(this))

        setTimeout(() => {
          window.electron.ipcRenderer.send('mt::request-keybindings')
          bus.emit('cmd::sort-commands')
        }, 100)
      }, 400)

      window.electron.ipcRenderer.on('mt::bootstrap-editor', (_, config) => {
        const {
          addBlankTab,
          markdownList,
          lineEnding,
          sideBarVisibility,
          tabBarVisibility,
          sourceCodeModeEnabled
        } = config

        window.electron.ipcRenderer.send('mt::window-initialized')
        mainStore.SET_INITIALIZED()
        preferencesStore.SET_USER_PREFERENCE({ endOfLine: lineEnding })
        layoutStore.SET_LAYOUT({
          rightColumn: 'files',
          showSideBar: !!sideBarVisibility,
          showTabBar: !!tabBarVisibility
        })
        layoutStore.DISPATCH_LAYOUT_MENU_ITEMS()
        preferencesStore.SET_MODE({
          type: 'sourceCode',
          checked: !!sourceCodeModeEnabled
        })

        if (addBlankTab) {
          this.NEW_UNTITLED_TAB({ selected: true })
        } else if (markdownList.length) {
          let isFirst = true
          for (const md of markdownList) {
            this.NEW_UNTITLED_TAB({
              markdown: md,
              selected: isFirst
            })
            isFirst = false
          }
        }
      })
    },

    // Open a new tab, optionally with content.
    LISTEN_FOR_NEW_TAB(): void {
      window.electron.ipcRenderer.on(
        'mt::open-new-tab',
        (_, markdownDocument, options = {}, selected = true) => {
          if (markdownDocument) {
            // Create tab with content.
            this.NEW_TAB_WITH_CONTENT({ markdownDocument, options, selected })
          } else {
            // Fallback: create a blank tab and always select it
            this.NEW_UNTITLED_TAB({})
          }
        }
      )

      window.electron.ipcRenderer.on(
        'mt::new-untitled-tab',
        (_, selected = true, markdown = '') => {
          // Create a blank tab
          this.NEW_UNTITLED_TAB({ markdown, selected })
        }
      )
      bus.on('mt::new-untitled-tab', (payload) => {
        const { selected = true, markdown = '' } =
          (payload as { selected?: boolean; markdown?: string } | undefined) ?? {}
        this.NEW_UNTITLED_TAB({ markdown, selected })
      })
    },

    CLOSE_TAB(file: IFileState | null = null): void {
      const target = file ?? this.currentFile
      if (target === null) return

      // F1(B-26)：`isSaved`/`markdown` 都取自 tab 快照，而引擎的 rAF 批里可能还有
      // 这一帧的最后一次编辑（尚未提交进 tab）——不 flush 就判定「已保存」，
      // 那一次输入会随着标签关闭消失。flush 是同步的，判定发生在它之后。
      this.flushActiveEditor()

      if (target.isSaved) {
        this.FORCE_CLOSE_TAB(target)
      } else {
        this.CLOSE_UNSAVED_TAB(target)
      }
    },

    LISTEN_FOR_CLOSE_TAB(): void {
      window.electron.ipcRenderer.on('mt::editor-close-tab', () => {
        this.CLOSE_TAB()
      })
      bus.on('mt::editor-close-tab', () => {
        this.CLOSE_TAB()
      })
    },

    LISTEN_FOR_TAB_CYCLE(): void {
      window.electron.ipcRenderer.on('mt::tabs-cycle-left', () => {
        this.CYCLE_TABS(false)
      })
      window.electron.ipcRenderer.on('mt::tabs-cycle-right', () => {
        this.CYCLE_TABS(true)
      })
      bus.on('mt::tabs-cycle-left', () => {
        this.CYCLE_TABS(false)
      })
      bus.on('mt::tabs-cycle-right', () => {
        this.CYCLE_TABS(true)
      })
    },

    LISTEN_FOR_SWITCH_TABS(): void {
      window.electron.ipcRenderer.on('mt::switch-tab-by-index', (_, index) => {
        this.SWITCH_TAB_BY_INDEX(index)
      })
      window.electron.ipcRenderer.on('mt::switch-tab-by-file_path', (_, filePath) => {
        this.SWITCH_TAB_BY_FILEPATH(filePath)
      })
    },

    FORCE_CLOSE_TAB(file: IFileState): void {
      const { tabs, currentFile } = this
      const index = tabs.findIndex((t) => t.id === file.id)

      // 关标签 = 离开这份文档：标注立即落盘（不等 800ms debounce，见方案 §5.5）。
      if (file.pathname) useAnnotationStore().flush(file.pathname)

      if (index > -1) {
        tabs.splice(index, 1)
        this.updateTabIdToIndex()
      }

      if (file.id && autoSaveTimers.has(file.id)) {
        const timer = autoSaveTimers.get(file.id)
        if (timer) clearTimeout(timer)
        autoSaveTimers.delete(file.id)
      }

      this.updateTabIdToIndex() // Update before sending it out to prevent stale mappings.

      if (currentFile && file.id === currentFile.id) {
        const fileState: IFileState | null =
          this.tabs[index] ?? this.tabs[index - 1] ?? this.tabs[0] ?? null
        this.currentFile = fileState
        if (fileState && typeof fileState.markdown === 'string') {
          const { id, markdown, cursor, history, pathname, scrollTop, blocks, muyaIndexCursor } =
            fileState
          window.DIRNAME = pathname ? window.path.dirname(pathname) : ''
          bus.emit('file-changed', {
            id,
            markdown,
            cursor,
            muyaIndexCursor,
            renderCursor: true,
            history,
            scrollTop,
            blocks
          })
          // 关掉的是当前标签 → 主文档换人，标注上下文跟着切。
          useAnnotationStore().SWITCH_DOC({ pathname, tabId: id })
        } else {
          window.DIRNAME = ''
        }
      }

      if (this.tabs.length === 0) {
        this.listToc = []
        this.toc = []
      }

      const { pathname } = file
      if (pathname) {
        window.electron.ipcRenderer.send('mt::window-tab-closed', pathname)
      }
      debouncedSendBufferedState()
    },

    CLOSE_UNSAVED_TAB(file: IFileState): void {
      // F1(B-26)：这个入口被 tabs.vue 的关闭按钮直接调用（不经过 CLOSE_TAB），
      // flush 放在这里才覆盖全部关标签路径——请求里带的是 tab 快照的 markdown，
      // 不 flush 就会把「这一帧还没提交的最后一次编辑」留在标签外。
      this.flushActiveEditor()
      const { id, pathname, filename, markdown } = file
      const options = getOptionsFromState(file)
      window.electron.ipcRenderer.send('mt::save-and-close-tabs', [
        {
          id,
          pathname,
          filename,
          markdown,
          options: deepClone(options),
          // F1(P0-4)：内容版本随请求走，主进程回执原样带回。
          version: getSaveVersion(file)
        }
      ])
    },

    CLOSE_OTHER_TABS(file: IFileState): void {
      this.tabs
        .filter((f) => f.id !== file.id)
        .forEach((tab) => {
          this.CLOSE_TAB(tab)
        })
    },

    CLOSE_SAVED_TABS(): void {
      this.tabs
        .filter((f) => f.isSaved)
        .forEach((tab) => {
          this.CLOSE_TAB(tab)
        })
    },

    CLOSE_ALL_TABS(): void {
      this.tabs.slice().forEach((tab) => {
        this.CLOSE_TAB(tab)
      })
    },

    CLOSE_TABS(tabIdList: string[]): void {
      if (!tabIdList || tabIdList.length === 0) return

      let tabIndex = 0
      tabIdList.forEach((id) => {
        const index = this.tabs.findIndex((f) => f.id === id)
        if (index === -1) return

        const closed = this.tabs[index]
        const { pathname } = closed ?? { pathname: '' }

        if (pathname) {
          window.electron.ipcRenderer.send('mt::window-tab-closed', pathname)
        }

        this.tabs.splice(index, 1)
        if (this.currentFile?.id === id) {
          this.currentFile = null
          window.DIRNAME = ''
          if (tabIdList.length === 1) {
            tabIndex = index
          }
        }
      })

      this.updateTabIdToIndex() // Update before sending it out to prevent stale mappings.

      if (this.currentFile == null && this.tabs.length > 0) {
        this.currentFile = this.tabs[tabIndex] ?? this.tabs[tabIndex - 1] ?? this.tabs[0] ?? null
        if (this.currentFile && typeof this.currentFile.markdown === 'string') {
          const { id, markdown, cursor, history, pathname, scrollTop, blocks, muyaIndexCursor } =
            this.currentFile
          window.DIRNAME = pathname ? window.path.dirname(pathname) : ''
          bus.emit('file-changed', {
            id,
            markdown,
            cursor,
            muyaIndexCursor,
            renderCursor: true,
            history,
            scrollTop,
            blocks
          })
        }
      }

      if (this.tabs.length === 0) {
        this.listToc = []
        this.toc = []
      }
      debouncedSendBufferedState()
    },

    EXCHANGE_TABS_BY_ID(tabIDs: { fromId: string; toId: string | null }): void {
      const { fromId, toId } = tabIDs
      const { tabs } = this
      const moveItem = <T>(arr: T[], from: number, to: number): boolean => {
        if (from === to) return true
        const len = arr.length
        const item = arr.splice(from, 1)
        if (item.length === 0) return false

        arr.splice(to, 0, item[0]!)
        return arr.length === len
      }

      const fromIndex = tabs.findIndex((t) => t.id === fromId)
      if (fromIndex === -1) return

      if (!toId) {
        moveItem(tabs, fromIndex, tabs.length - 1)
      } else {
        const toIndex = tabs.findIndex((t) => t.id === toId)
        if (toIndex === -1) return
        const realToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
        moveItem(tabs, fromIndex, realToIndex)
      }
      this.updateTabIdToIndex()
      debouncedSendBufferedState()
    },

    RENAME_FILE(file: IFileState): void {
      this.UPDATE_CURRENT_FILE(file)
      bus.emit('rename')
    },

    // Direction is a boolean where false is left and true right.
    CYCLE_TABS(direction: boolean): void {
      const { tabs, currentFile } = this
      if (tabs.length <= 1) {
        return
      }

      const currentIndex = tabs.findIndex((t) => t.id === currentFile?.id)
      if (currentIndex === -1) {
        console.error('CYCLE_TABS: Cannot find current tab index.')
        return
      }

      let nextTabIndex = 0
      if (!direction) {
        // Switch tab to the left.
        nextTabIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1
      } else {
        // Switch tab to the right.
        nextTabIndex = (currentIndex + 1) % tabs.length
      }

      const nextTab = tabs[nextTabIndex]
      if (!nextTab || !nextTab.id) {
        console.error(`CYCLE_TABS: Cannot find next tab (index="${nextTabIndex}").`)
        return
      }

      this.UPDATE_CURRENT_FILE(nextTab)
    },

    SWITCH_TAB_BY_FILEPATH(filePath: string): void {
      const { tabs } = this

      if (!filePath) {
        console.warn('Invalid file path:', filePath)
        return
      }

      const nextTabIndex = tabs.findIndex((t) => t.pathname === filePath)
      if (nextTabIndex === -1) {
        console.error('Cannot find tab with pathname:', filePath)
        return
      }
      const next = tabs[nextTabIndex]
      if (next) this.UPDATE_CURRENT_FILE(next)
    },

    SWITCH_TAB_BY_INDEX(nextTabIndex: number): void {
      const { tabs, currentFile } = this
      if (nextTabIndex < 0 || nextTabIndex >= tabs.length) {
        console.warn('Invalid tab index:', nextTabIndex)
        return
      }

      const currentIndex = tabs.findIndex((t) => t.id === currentFile?.id)
      if (currentIndex === -1) {
        console.error('Cannot find current tab index.')
        return
      }

      const nextTab = tabs[nextTabIndex]
      if (!nextTab || !nextTab.id) {
        console.error(`Cannot find tab by index="${nextTabIndex}".`)
        return
      }
      this.UPDATE_CURRENT_FILE(nextTab)
    },

    /**
     * Create a new untitled tab, optionally seeded with markdown content.
     */
    NEW_UNTITLED_TAB({
      markdown: markdownString,
      selected
    }: {
      markdown?: string
      selected?: boolean
    }): void {
      if (selected == null) {
        selected = true
      }

      this.SHOW_TAB_VIEW(false)

      const preferencesStore = usePreferencesStore()
      const { defaultEncoding, endOfLine } = preferencesStore
      const fileState = getBlankFileState(
        this.tabs,
        defaultEncoding,
        endOfLine,
        markdownString ?? null
      )

      if (selected) {
        const { id, markdown } = fileState
        this.UPDATE_CURRENT_FILE(fileState)
        bus.emit('file-loaded', { id, markdown })
      } else {
        this.tabs.push(fileState)
        this.updateTabIdToIndex()
        debouncedSendBufferedState()
      }
    },

    /**
     * Create a new tab from the given markdown document.
     */
    NEW_TAB_WITH_CONTENT({
      markdownDocument,
      options = {},
      selected
    }: {
      markdownDocument: MarkdownDocument | null | undefined
      options?: TabOptions
      selected?: boolean
    }): void {
      if (!markdownDocument) {
        console.warn('Cannot create a file tab without a markdown document!')
        this.NEW_UNTITLED_TAB({})
        return
      }

      if (typeof selected === 'undefined') {
        selected = true
      }

      const { currentFile, tabs } = this
      const { pathname } = markdownDocument
      const existingTab = tabs.find((t) =>
        window.fileUtils.isSamePathSync(t.pathname, pathname ?? '')
      )
      if (existingTab) {
        this.UPDATE_CURRENT_FILE(existingTab)
        return
      }

      // round10：直建标签路径（「打开文件…」/拖放等）不经过主进程 openTab，
      // 主动通知主进程把该文件挂进单文件 watcher——外部修改才能触发
      // mt::update-file → 文件变更横幅（复刻 MarkText 行为）。
      if (pathname) {
        window.electron.ipcRenderer.send('mt::window-add-file-path', pathname)
      }

      let keepTabBarState = false
      if (currentFile) {
        const { isSaved, pathname: cfPath } = currentFile
        if (isSaved && !cfPath) {
          keepTabBarState = true
          this.FORCE_CLOSE_TAB(currentFile)
        }
      }

      if (!keepTabBarState) {
        this.SHOW_TAB_VIEW(false)
      }

      const { markdown, isMixedLineEndings } = markdownDocument
      const docState = createDocumentState(
        Object.assign(
          {},
          markdownDocument as unknown as Record<string, unknown>,
          options as Record<string, unknown>
        )
      )
      const { id, cursor } = docState

      if (selected) {
        this.UPDATE_CURRENT_FILE(docState)
        bus.emit('file-loaded', { id, markdown, cursor })
      } else {
        this.tabs.push(docState)
        this.updateTabIdToIndex()
        debouncedSendBufferedState()
      }

      if (isMixedLineEndings) {
        const { filename, lineEnding } = markdownDocument
        if (typeof lineEnding === 'string') {
          this.pushTabNotification({
            tabId: id,
            msg: t('store.editor.mixedLineEndingsNormalized', {
              name: filename,
              lineEnding: lineEnding.toUpperCase()
            })
          })
        }
      }
    },

    SHOW_TAB_VIEW(always: boolean): void {
      const { tabs } = this
      const layoutStore = useLayoutStore()
      if (always || tabs.length === 1) {
        layoutStore.SET_LAYOUT({ showTabBar: true })
        layoutStore.DISPATCH_LAYOUT_MENU_ITEMS()
      }
    },

    SET_SAVE_STATUS_WHEN_REMOVE({ pathname }: { pathname: string }): void {
      let didUpdateSaveStatus = false
      this.tabs.forEach((f) => {
        if (f.pathname === pathname) {
          f.isSaved = false
          didUpdateSaveStatus = true
        }
      })
      if (didUpdateSaveStatus) {
        debouncedSendBufferedState()
      }
    },

    /**
     * Replaces the table of contents with a fresh snapshot from the engine.
     *
     * Used on file load and tab switch, where the engine fires no `json-change`
     * event (so `LISTEN_FOR_CONTENT_CHANGE` never runs and the TOC would
     * otherwise stay empty until the first edit). Assigns unconditionally: this
     * is a re-seed on load/switch, so there is no `equal` guard to short-circuit
     * — the incoming snapshot always wins, even if it happens to deep-equal the
     * current TOC.
     * @param toc Flat list of headings returned by `muya.getTOC()`.
     */
    UPDATE_TOC(toc: TocItem[]): void {
      this.listToc = toc ?? []
      this.toc = listToTree<TocItem>(toc ?? [])
    },

    // Content change from realtime preview editor and source code editor
    // There is a chance that this event is fired AFTER the tab is switched.
    LISTEN_FOR_CONTENT_CHANGE({
      id,
      markdown,
      wordCount,
      cursor,
      muyaIndexCursor,
      history,
      toc,
      blocks
    }: ContentChangePayload): void {
      const preferencesStore = usePreferencesStore()
      const { autoSave } = preferencesStore
      if (!id) {
        throw new Error('Listen for document change but id was not set!')
      } else if (this.tabs.length === 0) {
        return
      } else if (!(id in this.tabIdToIndex)) {
        // This only happens when the sourceCode tries to write a stale id via prepareTabSwitch() but the tab
        // has already been closed. In this case we can safely ignore the update.
        return
      }

      const tab = this.tabs[this.tabIdToIndex[id]!]
      if (!tab) return

      const { filename, pathname, markdown: oldMarkdown, trimTrailingNewline } = tab

      markdown = adjustTrailingNewlines(markdown, trimTrailingNewline)
      tab.markdown = markdown

      if (oldMarkdown.length === 0 && markdown.length === 1 && markdown[0] === '\n') {
        debouncedSendBufferedState()
        return
      }

      if (wordCount) tab.wordCount = wordCount
      if (cursor) tab.cursor = cursor
      if (muyaIndexCursor) tab.muyaIndexCursor = muyaIndexCursor
      if (history) tab.history = history
      if (blocks) tab.blocks = blocks

      // Only update TOC if it's the current file
      if (id === this.currentFile?.id && toc && !equal(toc, this.listToc)) {
        this.listToc = toc
        this.toc = listToTree<TocItem>(toc)
      }

      const lastEditIndex = tab.history.lastEditIndex
      const editEntry =
        typeof lastEditIndex === 'number' && lastEditIndex >= 0
          ? tab.history.stack[lastEditIndex]
          : undefined
      const historyMarksDirty =
        (typeof lastEditIndex === 'number' &&
          lastEditIndex >= 0 &&
          editEntry !== undefined &&
          editEntry.id !== tab.lastSavedHistoryId) ||
        (lastEditIndex === -1 &&
          tab.lastSavedHistoryId !== -1 &&
          tab.lastSavedHistoryId !== tab.history.lastInitIndex) // Edge Case: Undo to original content (lastEditIndex === -1) after saving means we cant use the lastEditIndex. Compare it against the lastInitIndex instead.
      const isDirty = history === undefined ? markdown !== oldMarkdown : historyMarksDirty
      if (isDirty) {
        tab.isSaved = false
        if (pathname && autoSave) {
          const options = getOptionsFromState(tab)
          this.HANDLE_AUTO_SAVE({
            id,
            filename,
            pathname,
            markdown,
            options
          })
        }
      } else if (history !== undefined && tab.lastSavedHistoryId !== -1) {
        // Check here is to prevent it from overriding a restored .isSaved state
        tab.isSaved = true // An undo can trigger this
      }
      debouncedSendBufferedState()
    },

    HANDLE_AUTO_SAVE({ id, filename, pathname, markdown, options }: AutoSavePayload): void {
      if (!id || !pathname) {
        throw new Error('HANDLE_AUTO_SAVE: Invalid tab.')
      }

      const preferencesStore = usePreferencesStore()
      const projectStore = useProjectStore()
      const { autoSaveDelay } = preferencesStore

      if (autoSaveTimers.has(id)) {
        const timer = autoSaveTimers.get(id)
        clearTimeout(timer)
        autoSaveTimers.delete(id)
      }

      // F1(P0-4)：版本在布防时取——定时器到点发出去的是这一刻的 markdown 快照，
      // 版本必须与之同源，否则回执对账会拿错基准。
      const version = getSaveVersion(this.tabs.find((t) => t.id === id))

      const timer = setTimeout(() => {
        autoSaveTimers.delete(id)

        const tab = this.tabs.find((t) => t.id === id)
        if (tab && !tab.isSaved) {
          const defaultPath = getRootFolderFromState(projectStore)
          window.electron.ipcRenderer.send(
            'mt::response-file-save',
            id,
            filename,
            pathname,
            markdown,
            deepClone(options),
            defaultPath,
            version
          )
        }
      }, autoSaveDelay)
      autoSaveTimers.set(id, timer)
    },

    SELECTION_CHANGE(changes: SelectionChange): void {
      const { start, end } = changes
      if (this.currentFile && start.key === end.key && start.block?.text) {
        const value = start.block.text.substring(start.offset, end.offset)
        this.currentFile.searchMatches = {
          matches: [],
          index: -1,
          value
        }
      }

      const { windowId } = window.marktext?.env ?? { windowId: -1 }
      window.electron.ipcRenderer.send(
        'mt::editor-selection-changed',
        windowId,
        createApplicationMenuState(changes)
      )
    },

    // Persist the caret for a tab without the heavy content-change pipeline. A
    // pure caret move (click / arrow key) fires `selection-change` but NOT
    // `json-change`, so `tab.cursor` — the position replayed when the tab is
    // re-activated — would otherwise only ever track the last EDIT, losing a
    // click-moved caret across an in-session tab switch. Lightweight by design:
    // it only stores the serialized caret, skipping markdown/blocks/TOC re-derivation
    // and the save/dirty bookkeeping LISTEN_FOR_CONTENT_CHANGE performs.
    PERSIST_CURSOR(id: string, cursor: unknown): void {
      if (!id || !cursor) return
      const index = this.tabIdToIndex[id]
      if (index == null) return
      const tab = this.tabs[index]
      if (tab) tab.cursor = cursor
    },

    SELECTION_FORMATS(formats: SelectionFormat[]): void {
      const { windowId } = window.marktext?.env ?? { windowId: -1 }
      window.electron.ipcRenderer.send(
        'mt::update-format-menu',
        windowId,
        createSelectionFormatState(formats)
      )
    },

    EXPORT({ type, content, pageOptions, headerTemplate, footerTemplate }: ExportPayload): void {
      if (this.currentFile === null) return

      let title = ''
      const { listToc } = this
      if (listToc && listToc.length > 0) {
        let headerRef: TocItem | undefined = listToc[0]
        const len = Math.min(listToc.length, 6)
        for (let i = 1; i < len; ++i) {
          if (headerRef?.lvl === 1) break
          const header = listToc[i]
          if (header && headerRef && (headerRef.lvl ?? 0) > (header.lvl ?? 0)) {
            headerRef = header
          }
        }
        title = headerRef?.content ?? ''
      }

      const { filename, pathname } = this.currentFile
      window.electron.ipcRenderer.send('mt::response-export', {
        type: type as ExportPayload['type'] as never,
        title,
        content: content ?? '',
        filename,
        pathname,
        pageOptions: pageOptions ?? {},
        headerTemplate,
        footerTemplate
      })
    },

    LISTEN_FOR_EXPORT_SUCCESS(): void {
      // 导出成功反馈由导出对话框的完成态展示（含「在 Finder 中显示」入口）。
      // 这里仅保留通道注册，避免与对话框重复弹通知。
      window.electron.ipcRenderer.on('mt::export-success', () => {})
    },

    PRINT_RESPONSE(): void {
      window.electron.ipcRenderer.send('mt::response-print')
    },

    LISTEN_FOR_PRINT_SERVICE_CLEARUP(): void {
      window.electron.ipcRenderer.on('mt::print-service-clearup', () => {
        bus.emit('print-service-clearup')
      })
    },

    SET_LINE_ENDING(lineEnding: LineEnding | string): void {
      if (!this.currentFile) return
      const { lineEnding: oldLineEnding } = this.currentFile
      if (lineEnding !== oldLineEnding) {
        this.currentFile.lineEnding = lineEnding
        this.currentFile.adjustLineEndingOnSave = lineEnding !== 'lf'
        this.currentFile.isSaved = true
        this.UPDATE_LINE_ENDING_MENU()
        debouncedSendBufferedState()
      }
    },

    LISTEN_FOR_SET_LINE_ENDING(): void {
      window.electron.ipcRenderer.on('mt::set-line-ending', (_, lineEnding) => {
        this.SET_LINE_ENDING(lineEnding)
      })
      bus.on('mt::set-line-ending', (lineEnding) => {
        this.SET_LINE_ENDING(lineEnding as LineEnding)
      })
    },

    LISTEN_FOR_SET_ENCODING(): void {
      bus.on('mt::set-file-encoding', (encodingName) => {
        if (!this.currentFile) return
        const { encoding } = this.currentFile.encoding
        if (encoding !== encodingName) {
          this.currentFile.encoding.encoding = encodingName as string
          this.currentFile.encoding.isBom = false
          this.currentFile.isSaved = true
          debouncedSendBufferedState()
        }
      })
    },

    LISTEN_FOR_SET_FINAL_NEWLINE(): void {
      bus.on('mt::set-final-newline', (value) => {
        if (!this.currentFile) return
        const { trimTrailingNewline } = this.currentFile
        if (trimTrailingNewline !== value) {
          this.currentFile.trimTrailingNewline = value as number
          this.currentFile.isSaved = true
          debouncedSendBufferedState()
        }
      })
    },

    LISTEN_FOR_FILE_CHANGE(): void {
      const preferencesStore = usePreferencesStore()
      window.electron.ipcRenderer.on('mt::update-file', (_, payload) => {
        const { type, change } = payload
        const { tabs } = this
        const { pathname } = change
        const tab = tabs.find((t) => window.fileUtils.isSamePathSync(t.pathname, pathname))
        if (tab) {
          const { id, isSaved, filename } = tab
          switch (type) {
            case 'unlink': {
              tab.isSaved = false
              this.pushTabNotification({
                tabId: id,
                msg: t('store.editor.fileRemovedOnDisk', { name: filename }),
                style: 'warn',
                showConfirm: false,
                exclusiveType: 'file_changed'
              })
              debouncedSendBufferedState()
              break
            }
            case 'add':
            case 'change': {
              // Only the file's metadata changed on disk (e.g. a git checkout
              // that left the content byte-identical) — there is nothing to
              // reload and no reason to warn the user (#1861).
              const newMarkdown = (change as unknown as FileChangePayload).data?.markdown
              if (typeof newMarkdown === 'string' && newMarkdown === tab.markdown) {
                break
              }

              const { autoSave } = preferencesStore
              if (autoSave) {
                if (autoSaveTimers.has(id)) {
                  const timer = autoSaveTimers.get(id)
                  if (timer) clearTimeout(timer)
                  autoSaveTimers.delete(id)
                }

                if (isSaved) {
                  this.loadChange(change as unknown as FileChangePayload)
                  return
                }
              }

              tab.isSaved = false
              this.pushTabNotification({
                tabId: id,
                msg: t('store.editor.fileChangedOnDisk', { name: filename }),
                showConfirm: true,
                exclusiveType: 'file_changed',
                action: (status) => {
                  if (status) {
                    this.loadChange(change as unknown as FileChangePayload)
                  }
                }
              })
              debouncedSendBufferedState()
              break
            }
            default:
              console.error(`LISTEN_FOR_FILE_CHANGE: Invalid type "${type}"`)
          }
        } else {
          console.error(`LISTEN_FOR_FILE_CHANGE: Cannot find tab for path "${pathname}".`)
        }
      })
    },

    ASK_FOR_IMAGE_PATH(): Promise<string[]> {
      return window.electron.ipcRenderer.invoke('mt::ask-for-image-path')
    },

    EDIT_ZOOM(zoomFactor: number): void {
      const preferencesStore = usePreferencesStore()
      zoomFactor = Number.parseFloat(zoomFactor.toFixed(3))
      const { zoom } = preferencesStore
      if (zoom !== zoomFactor) {
        preferencesStore.SET_SINGLE_PREFERENCE({ type: 'zoom', value: zoomFactor })
      }
      window.electron.webFrame.setZoomFactor(zoomFactor)
    },

    LISTEN_WINDOW_ZOOM(): void {
      window.electron.ipcRenderer.on('mt::window-zoom', (_, zoomFactor) => {
        this.EDIT_ZOOM(zoomFactor)
      })
      bus.on('mt::window-zoom', (zoomFactor) => {
        this.EDIT_ZOOM(zoomFactor as number)
      })
    },

    LISTEN_FOR_RELOAD_IMAGES(): void {
      window.electron.ipcRenderer.on('mt::invalidate-image-cache', () => {
        bus.emit('invalidate-image-cache')
      })
    },

    LISTEN_FOR_CONTEXT_MENU(): void {
      // General context menu
      window.electron.ipcRenderer.on('mt::cm-copy-as-rich', () => {
        bus.emit('copyAsRich', 'copyAsRich')
      })
      window.electron.ipcRenderer.on('mt::cm-copy-as-html', () => {
        bus.emit('copyAsHtml', 'copyAsHtml')
      })
      window.electron.ipcRenderer.on('mt::cm-paste-as-plain-text', () => {
        bus.emit('pasteAsPlainText', 'pasteAsPlainText')
      })
      window.electron.ipcRenderer.on('mt::cm-insert-paragraph', (_, location) => {
        bus.emit('insertParagraph', location)
      })

      // Spelling
      window.electron.ipcRenderer.on('mt::spelling-replace-misspelling', (_, info) => {
        bus.emit('replace-misspelling', info)
      })
      window.electron.ipcRenderer.on('mt::spelling-show-switch-language', () => {
        bus.emit('open-command-spellchecker-switch-language')
      })
    },

    LISTEN_FOR_STATE_REPLACE(): void {
      window.electron.ipcRenderer.on('mt::load-state', (_, state) => {
        this.RESTORE_BUFFERED_STATE(state)
      })
    }
  }
})

// ----------------------------------------------------------------------------

/**
 * Return the opened root folder or an empty string.
 *
 * @param {object} projectStore The project store instance.
 */
const getRootFolderFromState = (projectStore: ProjectStoreLike): string => {
  const openedFolder = projectStore.projectTree
  if (openedFolder) {
    return openedFolder.pathname ?? ''
  }
  return ''
}

/**
 * F1(P0-4)：内容版本——保存回执对账用的标尺。
 *
 * 取当前编辑帧在 history 栈里的 id，与既有脏标记判定（`lastSavedHistoryId`）
 * 同一套标尺：`markdown` 与 `history` 由同一次 json-change 一起写进 tab，所以
 * 「发送保存请求时登记的版本」＝「那一刻写进文件的内容」。没有编辑帧（初始态、
 * 撤销回初始、引擎重建历史）时返回 -1。
 */
const getSaveVersion = (tab: IFileState | null | undefined): number => {
  const index = tab?.history?.lastEditIndex
  const stack = tab?.history?.stack
  if (typeof index !== 'number' || index < 0 || !Array.isArray(stack) || index >= stack.length) {
    return -1
  }
  const entry = stack[index]
  return entry && typeof entry.id === 'number' ? entry.id : -1
}

/**
 * Trim the final newlines according `trimTrailingNewlineOption`.
 *
 * F1(P0-5)：导出给 editor.vue 的左右同步 watch 用——`tab.markdown` 是**规整过**的
 * 内容（内容落 tab 时就按这个函数处理过），而引擎 `getMarkdown()` 是原始输出
 * （Muya 总会补一个末尾换行）。两者直接比较在 trimTrailingNewline=0/1 的文件上
 * 永不相等，左右同步会退化成「每次按键整篇 setContent」：光标复位、撤销历史
 * 清空、内嵌 HTML 帧重载。比较前必须用同一把尺子规整。
 *
 * @param markdown The text to trim.
 * @param trimTrailingNewlineOption The option how we should trim the final newlines.
 */
export const adjustTrailingNewlines = (
  markdown: string,
  trimTrailingNewlineOption: number
): string => {
  if (!markdown) {
    return ''
  }

  switch (trimTrailingNewlineOption) {
    // Trim trailing newlines.
    case 0: {
      return trimTrailingNewlines(markdown)
    }
    // Ensure single trailing newline.
    case 1: {
      // Muya will always add a final new line to the markdown text. Check first whether
      // only one newline exist to prevent copying the string.
      const lastIndex = markdown.length - 1
      if (markdown[lastIndex] === '\n') {
        if (markdown.length === 1) {
          // Just return nothing because adding a final new line makes no sense.
          return ''
        } else if (markdown[lastIndex - 1] !== '\n') {
          return markdown
        }
      }

      // Otherwise trim trailing newlines and add one.
      markdown = trimTrailingNewlines(markdown)
      if (markdown.length === 0) {
        // Just return nothing because adding a final new line makes no sense.
        return ''
      }
      return markdown + '\n'
    }
    // Disabled, use text as it is.
    default:
      return markdown
  }
}

/**
 * Trim trailing newlines from `text`.
 *
 * @param {string} text The text to trim.
 */
const trimTrailingNewlines = (text: string): string => {
  // F1(P0-3)：必须是 `(?:\r?\n)+`（CR 可选 + LF 一组，重复若干次）——写成字符类
  // `[\r?\n]+` 时 `?` 是**字面量**，末尾连续的 `?` 会被当换行删掉：正文以
  // 「Why?」结尾的文件保存一次就变「Why」（trimTrailingNewline=0 的文件每次
  // 内容规整都会走这里，见 adjustTrailingNewlines）。
  return text.replace(/(?:\r?\n)+$/, '')
}

interface ApplicationMenuState {
  isDisabled: boolean
  isMultiline: boolean
  isLooseListItem: boolean
  isTaskList: boolean
  isCodeFences: boolean
  isCodeContent: boolean
  isTable: boolean
  hasFrontMatter: boolean
  affiliation: Record<string, boolean>
}

/**
 * Creates a object that contains the application menu state.
 *
 * @param {*} selection The selection.
 * @returns A object that represents the application menu state.
 */
const createApplicationMenuState = ({
  start,
  end,
  affiliation,
  hasFrontMatter
}: SelectionChange): ApplicationMenuState => {
  const state: ApplicationMenuState = {
    isDisabled: false,
    // Whether multiple lines are selected.
    isMultiline: start.key !== end.key,
    // List information - a list must be selected.
    isLooseListItem: false,
    isTaskList: false,
    // Whether the selection is code block like (math, html or code block).
    isCodeFences: false,
    // Whether a code block line is selected.
    isCodeContent: false,
    // Whether the selection contains a table.
    isTable: false,
    hasFrontMatter: !!hasFrontMatter,
    // Contains keys about the selection type(s) (string, boolean) like "ul: true".
    affiliation: {}
  }
  const { isMultiline } = state
  const aff: AffiliationEntry[] = affiliation ?? []
  const startBlock: { text?: string; functionType?: string } = start.block ?? {}
  const endBlock: { functionType?: string } = end.block ?? {}

  // Get code block information from selection.
  if (
    (startBlock.functionType === 'cellContent' && endBlock.functionType === 'cellContent') ||
    (start.type === 'span' && startBlock.functionType === 'codeContent') ||
    (end.type === 'span' && endBlock.functionType === 'codeContent')
  ) {
    // A code block like block is selected (code, math, ...).
    state.isCodeFences = true

    // A code block line is selected.
    if (startBlock.functionType === 'codeContent' || endBlock.functionType === 'codeContent') {
      state.isCodeContent = true
    }
  }

  // Check every list level in the affiliation chain — nested lists show all
  // levels (e.g. a ul wrapping an ol checks both). Scanning the full chain (not
  // just the depth-3 loop below) keeps a deeply nested inner list checked. The
  // loose/task flags come from the INNERMOST list (the one the cursor is in);
  // the chain is outermost-first, so that is the last ul/ol entry.
  const listEntries = aff.filter((b) => b.type === 'ul' || b.type === 'ol')
  for (const entry of listEntries) {
    // Task and bullet lists are both `type: 'ul'`; distinguish by listType so a
    // chain with several kinds (e.g. ol > task > ul) checks each list menu item.
    const kind = entry.type === 'ol' ? 'ol' : entry.listType === 'task' ? 'task' : 'ul'
    state.affiliation[kind] = true
  }
  const innerList = listEntries[listEntries.length - 1]
  if (innerList) {
    // The engine's affiliation entry carries the loose flag on the list block
    // itself (derived from `meta.loose`), not via a `children` chain.
    state.isLooseListItem = !!innerList.isLooseListItem
    state.isTaskList = innerList.listType === 'task'
  }

  // Search with block depth 3 (e.g. "ul -> li -> p" where p is the actually paragraph inside the list (item)).
  for (const b of aff.slice(0, 3)) {
    if (b.type === 'pre' && b.functionType) {
      if (/frontmatter|html|multiplemath|code$/.test(b.functionType)) {
        state.isCodeFences = true
        state.affiliation[b.functionType] = true
      }
      break
    } else if (b.type === 'figure' && b.functionType) {
      if (b.functionType === 'table') {
        state.isTable = true
        state.isDisabled = true
        state.affiliation[b.type] = true
      } else if (b.functionType === 'diagram') {
        // Diagrams are atomic, non-formattable blocks: disable the whole
        // paragraph + format menus like a code fence, but they are not tables.
        state.isCodeFences = true
        state.affiliation[b.functionType] = true
      }
      break
    } else if (isMultiline && /^h{1,6}$/.test(b.type)) {
      // Multiple block elements are selected.
      state.affiliation = {}
      break
    } else if (b.type !== 'ul' && b.type !== 'ol') {
      // Lists are handled above (innermost only); the depth-limited scan must
      // not re-add an outer list type and check two list kinds at once.
      if (!state.affiliation[b.type]) {
        state.affiliation[b.type] = true
      }
    }
  }

  if (Object.getOwnPropertyNames(state.affiliation).length >= 2 && state.affiliation.p) {
    delete state.affiliation.p
  }
  if ((state.affiliation.ul || state.affiliation.ol) && state.affiliation.li) {
    delete state.affiliation.li
  }
  return state
}

/**
 * Creates a object that contains the formats selection state.
 */
export const createSelectionFormatState = (formats: SelectionFormat[]): Record<string, boolean> => {
  const state: Record<string, boolean> = {}
  for (const item of formats) {
    // Underline/superscript/subscript/highlight are carried as `html_tag`
    // tokens whose `tag` (u/sup/sub/mark) is the real format key the menu
    // map keys off — the bare `type` would only ever yield `html_tag`.
    const key = item.type === 'html_tag' ? (item.tag as string) : item.type
    if (key) state[key] = true
  }
  return state
}

/*
 * Convert a Pinia Proxy Object to a serializable value by applying JSON stringify and parse.
 */
function toSerializableValue<T>(value: T | null | undefined, fallback: T): T
function toSerializableValue<T>(value: T | null | undefined, fallback: null): T | null
function toSerializableValue<T>(value: T | null | undefined, fallback: T | null = null): T | null {
  if (value == null) return fallback

  try {
    return deepClone(value) as T
  } catch (err) {
    console.warn('Unable to serialize editor buffer value:', err)
    return fallback
  }
}

interface BufferedTabState {
  id: string
  pathname: string
  filename: string
  markdown: string
  isSaved: boolean
  encoding: IFileState['encoding']
  lineEnding: IFileState['lineEnding']
  trimTrailingNewline: number
  adjustLineEndingOnSave: boolean
  cursor: unknown
  wordCount: IFileState['wordCount']
  muyaIndexCursor: unknown
  scrollTop: number
}

const createBufferedTabState = (tab: Partial<IFileState> & { id: string }): BufferedTabState => {
  return {
    id: tab.id,
    pathname: tab.pathname ?? defaultFileState.pathname,
    filename: tab.filename ?? defaultFileState.filename,
    markdown: typeof tab.markdown === 'string' ? tab.markdown : defaultFileState.markdown,
    isSaved: tab.isSaved ?? defaultFileState.isSaved,
    encoding: toSerializableValue(tab.encoding, defaultFileState.encoding),
    lineEnding: tab.lineEnding ?? defaultFileState.lineEnding,
    trimTrailingNewline:
      typeof tab.trimTrailingNewline === 'number'
        ? tab.trimTrailingNewline
        : defaultFileState.trimTrailingNewline,
    adjustLineEndingOnSave: tab.adjustLineEndingOnSave ?? defaultFileState.adjustLineEndingOnSave,
    cursor: toSerializableValue(tab.cursor, defaultFileState.cursor),
    wordCount: toSerializableValue(tab.wordCount, defaultFileState.wordCount),
    muyaIndexCursor: toSerializableValue(tab.muyaIndexCursor, defaultFileState.muyaIndexCursor),
    scrollTop: tab.scrollTop ?? defaultFileState.scrollTop
  }
}

interface BufferedRestoreWarning {
  tabId: string | null
  pathname: string
  msg: string
  showConfirm: boolean
  style: string
  exclusiveType: string
}

const createBufferedRestoreWarning = (
  warning: RestoreWarning | null | undefined
): BufferedRestoreWarning | null => {
  if (!warning) return null

  const { tabId, pathname, msg, showConfirm, style, exclusiveType } = warning
  if (!tabId && !pathname) return null
  if (!msg) return null

  return {
    tabId: tabId || null,
    pathname: pathname || '',
    msg,
    showConfirm: !!showConfirm,
    style: style || 'info',
    exclusiveType: exclusiveType || ''
  }
}

interface BufferedEditorState {
  currentFileId: string | null
  tabs: BufferedTabState[]
  restoreWarnings: BufferedRestoreWarning[]
}

const createBufferedEditorState = (state: unknown): BufferedEditorState | null => {
  const s = state as
    | {
        tabs?: unknown
        currentFileId?: string
        currentFile?: { id?: string } | null
        restoreWarnings?: unknown
      }
    | null
    | undefined
  if (!s || !Array.isArray(s.tabs)) {
    return null
  }

  return {
    currentFileId: s.currentFileId || s.currentFile?.id || null,
    tabs: (s.tabs as Array<Partial<IFileState> & { id: string }>).map(createBufferedTabState),
    restoreWarnings: Array.isArray(s.restoreWarnings)
      ? (s.restoreWarnings as RestoreWarning[])
          .map(createBufferedRestoreWarning)
          .filter((w): w is BufferedRestoreWarning => w !== null)
      : []
  }
}
