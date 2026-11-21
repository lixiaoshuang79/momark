import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// `listenForMain` pulls in the layout store, which transitively imports the
// preferences store and `@/config` (the latter reads `window.path.sep` at
// module load). Stub the contextBridge surfaces before the hoisted imports run
// so the store graph can load.
vi.hoisted(() => {
  const w = globalThis as unknown as { window?: { path?: { sep: string } } }
  w.window ??= {}
  w.window.path ??= { sep: '/' }
})

import { useListenForMainStore } from '@/store/listenForMain'
import { useLayoutStore } from '@/store/layout'

// The layout store pulls in the preferences store, and the renderer i18n module
// reads `window.electron.ipcRenderer` at import time. Provide spies for it.
const win = window as unknown as {
  electron?: { ipcRenderer: { on: Mock; send: Mock; invoke: Mock } }
  marktext?: { env: { windowId: number } }
}

describe('listenForMain store EDITOR_EDIT_ACTION', () => {
  beforeEach(() => {
    win.electron = {
      ipcRenderer: {
        on: vi.fn(),
        send: vi.fn(),
        invoke: vi.fn(() => Promise.resolve(false))
      }
    }
    win.marktext = { env: { windowId: 1 } }
    setActivePinia(createPinia())
  })

  afterEach(() => {
    delete win.electron
    delete win.marktext
    vi.clearAllMocks()
  })

  it("opens the folder drawer for 'findInFolder'", () => {
    const layoutStore = useLayoutStore()
    expect(layoutStore.folderDrawerOpen).toBe(false)

    useListenForMainStore().EDITOR_EDIT_ACTION('findInFolder')

    expect(layoutStore.folderDrawerOpen).toBe(true)
  })

  it('does not mutate the layout for a non-findInFolder action', () => {
    const layoutStore = useLayoutStore()

    useListenForMainStore().EDITOR_EDIT_ACTION('insertParagraph')

    expect(layoutStore.folderDrawerOpen).toBe(false)
  })
})
