import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 路径迁移（改名 / 另存为 / 未保存文档落盘）的**数据保全**回归。
 *
 * 修复前的链路：`ADOPT_PATH` 把未保存文档的内存表直接挂到目标 key、`MIGRATE_PATH`
 * 让主进程用源文件整份顶掉目标文件，而主进程的保存合并规则是「传入版本为准」
 * （`mergeAnnotations`）——于是「另存为到一个已有标注的文件」会把那个文件积累的
 * 标注从盘上删掉，且不可恢复。
 *
 * 这里用**真的主进程 AnnotationStore**（临时目录）当假 IPC 的后端，所以同时钉住
 * 两侧：主进程的并集迁移 + 渲染层迁移后把盘上并集读回内存（否则下一次 flush 会按
 * 非并集规则再抹一次）。
 */

const DIRS: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-ann-migrate-'))
  DIRS.push(dir)
  return dir
}

let realStore: InstanceType<typeof AnnotationStore>

vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: { sep: string; dirname: (p: string) => string }
      electron?: {
        ipcRenderer: {
          invoke: Mock
          send: (...a: unknown[]) => void
          on: (...a: unknown[]) => void
        }
        clipboard: { writeText: (s: string) => void }
      }
    }
  }
  w.window ??= {}
  w.window.path ??= { sep: '/', dirname: (p: string) => p }
  w.window.electron ??= {
    ipcRenderer: { invoke: vi.fn(), send: () => {}, on: () => {} },
    clipboard: { writeText: () => {} }
  }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))
vi.mock('@/store/preferences', () => ({
  usePreferencesStore: () => ({ annotationEnabled: true })
}))
vi.mock('@/store/browserPanel', () => ({
  useBrowserPanelStore: () => ({ activeTab: 'annotation', SET_TAB: vi.fn() })
}))

import AnnotationStore from 'main_renderer/annotationStore'
import { useAnnotationStore } from '@/store/annotation'
import type { IAnnotation, IAnnotationAnchor } from '@shared/types/ipc'

const anchor = (quote: string): IAnnotationAnchor => ({
  ranges: [{ blockPath: [0], blockName: 'paragraph.content', start: 0, end: quote.length }],
  quote,
  prefix: '',
  suffix: '',
  blockText: quote,
  beforeBlockText: '',
  afterBlockText: '',
  blockPath: [0],
  headingPath: ['第一章']
})

const ann = (id: string, note: string, patch: Partial<IAnnotation> = {}): IAnnotation => ({
  id,
  anchor: anchor('原文'),
  note,
  copied: false,
  archived: false,
  anchorState: 'anchored',
  createdAt: 1,
  updatedAt: 1,
  ...patch
})

const SRC = '/tmp/docs/src.md'
const DST = '/tmp/docs/dst.md'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  realStore = new AnnotationStore({ annotationStorePath: tempDir() })
  ;(window.electron.ipcRenderer.invoke as Mock).mockImplementation(
    async (channel: string, payload: never) => {
      if (channel === 'mt::annotation::load') return realStore.load(payload)
      if (channel === 'mt::annotation::save') return realStore.save(payload)
      if (channel === 'mt::annotation::migrate-path') return realStore.migratePath(payload)
      return undefined
    }
  )
})

afterEach(() => {
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('标注路径迁移 — 目标已有标注时必须并集', () => {
  it('MIGRATE_PATH：改名到一个已有标注的路径，两侧都留在盘上', async () => {
    realStore.save({ pathname: SRC, round: 2, annotations: [ann('src', '被移入')] })
    realStore.save({ pathname: DST, round: 4, annotations: [ann('dst', '目标原有')] })

    const store = useAnnotationStore()
    store.docs[SRC] = { round: 2, annotations: [ann('src', '被移入')], loaded: true }
    store.activeKey = SRC

    await store.MIGRATE_PATH({ from: SRC, to: DST })

    // 盘上：目标原有 + 移入（并集），轮次取较大值
    const onDisk = realStore.load(DST)
    expect(onDisk.annotations.map((a) => a.id)).toEqual(['dst', 'src'])
    expect(onDisk.annotations.map((a) => a.note)).toEqual(['目标原有', '被移入'])
    expect(onDisk.round).toBe(4)
    expect(realStore.load(SRC).annotations).toEqual([])

    // 内存：迁移后以盘上那份并集为准（否则下一次 flush 会再抹掉目标标注）
    expect(store.docs[DST].annotations.map((a) => a.id)).toEqual(['dst', 'src'])
    expect(store.docs[DST].round).toBe(4)
    expect(store.docs[SRC]).toBeUndefined()
    expect(store.activeKey).toBe(DST)
  })

  it('ADOPT_PATH：未保存文档另存为覆盖一个已有标注的文件，目标标注不被抹掉', async () => {
    realStore.save({ pathname: DST, round: 3, annotations: [ann('dst', '目标原有')] })

    const store = useAnnotationStore()
    store.docs['untitled:tab-1'] = {
      round: 1,
      annotations: [ann('buf', '缓冲区的标注', { updatedAt: 50 })],
      loaded: true
    }
    store.activeKey = 'untitled:tab-1'

    await store.ADOPT_PATH({ tabId: 'tab-1', pathname: DST })

    const onDisk = realStore.load(DST)
    expect(onDisk.annotations.map((a) => a.id)).toEqual(['dst', 'buf'])
    expect(onDisk.round).toBe(3)
    expect(store.docs['untitled:tab-1']).toBeUndefined()
    expect(store.docs[DST].annotations.map((a) => a.id)).toEqual(['dst', 'buf'])
    expect(store.activeKey).toBe(DST)
  })

  it('ADOPT_PATH：目标路径没有标注文件时与从前一致（只有缓冲区的条目）', async () => {
    const store = useAnnotationStore()
    store.docs['untitled:tab-2'] = {
      round: 1,
      annotations: [ann('buf', '唯一的标注')],
      loaded: true
    }
    store.activeKey = 'untitled:tab-2'

    await store.ADOPT_PATH({ tabId: 'tab-2', pathname: DST })

    expect(realStore.load(DST).annotations.map((a) => a.id)).toEqual(['buf'])
    expect(store.docs[DST].round).toBe(1)
  })
})
