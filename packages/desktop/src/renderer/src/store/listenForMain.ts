import { defineStore } from 'pinia'
import bus from '../bus'
import { useLayoutStore } from './layout'

export const useListenForMainStore = defineStore('listenForMain', () => {
  function EDITOR_EDIT_ACTION(type: string): void {
    // 「在文件夹中查找」原先打开侧栏的搜索面板；侧栏移除后改为打开文件夹抽屉，
    // 并把焦点放进它的筛选框（抽屉监听同名总线事件）。
    if (type === 'findInFolder') {
      useLayoutStore().SET_FOLDER_DRAWER(true)
    }
    bus.emit(type, type)
  }

  function LISTEN_FOR_EDIT(): void {
    // Pass `type` through as-is (no String() coercion) — matches develop's JS
    // behavior, including when callers send unexpected non-string values.
    window.electron.ipcRenderer.on('mt::editor-edit-action', (_e, type) => {
      EDITOR_EDIT_ACTION(type as string)
    })
    bus.on('mt::editor-edit-action', (type: unknown) => {
      EDITOR_EDIT_ACTION(type as string)
    })
  }

  function LISTEN_FOR_SHOW_DIALOG(): void {
    window.electron.ipcRenderer.on('mt::show-export-dialog', (_e, type) => {
      bus.emit('showExportDialog', type)
    })
  }

  function LISTEN_FOR_PARAGRAPH_INLINE_STYLE(): void {
    // Pre-migration JS destructured `{ type }` and re-emitted it without a
    // guard. Restore the same shape; bus listeners that expect a payload get
    // the same `type` value (string at runtime per main process emitters).
    window.electron.ipcRenderer.on('mt::editor-paragraph-action', (_e, { type }) => {
      bus.emit('paragraph', type)
    })
    window.electron.ipcRenderer.on('mt::editor-format-action', (_e, { type }) => {
      bus.emit('format', type)
    })
  }

  return {
    EDITOR_EDIT_ACTION,
    LISTEN_FOR_EDIT,
    LISTEN_FOR_SHOW_DIALOG,
    LISTEN_FOR_PARAGRAPH_INLINE_STYLE
  }
})
