import debounce from 'lodash/debounce'
import { useEditorStore } from './editor'
import { useProjectStore } from './project'
import { useLayoutStore } from './layout'

const BUFFERED_STATE_DEBOUNCE_MS = 1000
const BUFFERED_STATE_VERSION = 1

interface StoreCache {
  editorStore: ReturnType<typeof useEditorStore> | null
  projectStore: ReturnType<typeof useProjectStore> | null
  layoutStore: ReturnType<typeof useLayoutStore> | null
}

const stores: StoreCache = {
  editorStore: null,
  projectStore: null,
  layoutStore: null
}

export const createBufferedState = (): Record<string, unknown> | null => {
  if (!stores.editorStore) {
    stores.editorStore = useEditorStore()
  }
  if (!stores.projectStore) {
    stores.projectStore = useProjectStore()
  }
  if (!stores.layoutStore) {
    stores.layoutStore = useLayoutStore()
  }

  const editorState = stores.editorStore.CREATE_BUFFERED_STATE()
  if (!editorState) return null

  return {
    version: BUFFERED_STATE_VERSION,
    ...editorState,
    project: stores.projectStore?.CREATE_BUFFERED_STATE?.() || null,
    layout: stores.layoutStore?.CREATE_BUFFERED_STATE?.() || null
  }
}

export const sendBufferedState = (): Promise<unknown> => {
  const snapshot = createBufferedState()
  if (snapshot) {
    return window.electron.ipcRenderer.invoke('update-buffer-state', snapshot)
  }

  return Promise.resolve(false)
}

// P2：这个防抖会把「当前所有标签的完整 markdown」结构化成一次 IPC 载荷（主进程
// 随后 JSON.stringify + 原子写 + fsync）。载荷大小由 `CREATE_BUFFERED_STATE()`
// 决定——它现在只发**未保存**的标签（已落盘的内容能从磁盘重开，没必要每秒重新
// 克隆一遍；多标签几十 MB 的旧载荷正是这一条的开销来源）。这里的防抖窗口
// （1s）与合流逻辑不变。
export const debouncedSendBufferedState = debounce(() => {
  sendBufferedState().catch((err) => {
    console.error('Failed to update buffered state', err)
  })
}, BUFFERED_STATE_DEBOUNCE_MS)
