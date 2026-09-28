import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import AnnotationStore, {
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_ROUNDS,
  docKey,
  mergeAnnotations,
  mergeUnion,
  pruneAnnotations
} from 'main_renderer/annotationStore'
import type { IAnnotation, IAnnotationAnchor } from '@shared/types/ipc'

/**
 * 主进程标注落盘库：读写 / 迁移 / 条目级合并 / 历史容量修剪。
 * 全部在临时目录里跑，不碰真实 userData。
 */

const DIRS: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-ann-'))
  DIRS.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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

const annotation = (patch: Partial<IAnnotation> = {}): IAnnotation => ({
  id: 'a1',
  anchor: anchor('原文'),
  note: '备注',
  copied: false,
  archived: false,
  anchorState: 'anchored',
  createdAt: 1,
  updatedAt: 1,
  ...patch
})

const DOC = '/tmp/docs/PRD.md'

describe('AnnotationStore — key 与文件布局', () => {
  it('文件名是 sha1(绝对路径)，一个文档一个文件', () => {
    const dir = tempDir()
    const store = new AnnotationStore({ annotationStorePath: dir })
    const file = store.fileForPath(DOC)

    expect(file).toBe(path.join(dir, `${docKey(DOC)}.json`))
    expect(docKey(DOC)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('空路径（未保存文档）没有文件 key —— 不落盘', () => {
    const dir = tempDir()
    const store = new AnnotationStore({ annotationStorePath: dir })
    expect(store.fileForPath('')).toBeNull()
    expect(store.save({ pathname: '', round: 1, annotations: [annotation()] })).toEqual({
      ok: true
    })
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('AnnotationStore — 读写往返', () => {
  it('文件不存在时返回空结构而不是报错', () => {
    const store = new AnnotationStore({ annotationStorePath: tempDir() })
    expect(store.load(DOC)).toMatchObject({
      version: 2,
      pathname: DOC,
      round: 0,
      annotations: []
    })
  })

  it('save → load 往返保留条目与轮次，并落盘 version 2', () => {
    const dir = tempDir()
    const store = new AnnotationStore({ annotationStorePath: dir })
    store.save({
      pathname: DOC,
      round: 3,
      docHash: 'abc',
      annotations: [annotation(), annotation({ id: 'a2', copied: true, round: 1 })]
    })

    const loaded = store.load(DOC)
    expect(loaded.version).toBe(2)
    expect(loaded.round).toBe(3)
    expect(loaded.docHash).toBe('abc')
    expect(loaded.annotations.map((a) => a.id)).toEqual(['a1', 'a2'])
    expect(loaded.updatedAt).toBeTypeOf('number')

    const raw = JSON.parse(readFileSync(store.fileForPath(DOC) as string, 'utf8'))
    expect(raw.pathname).toBe(DOC)
  })

  it('坏文件（空 / 非法 JSON）退化成空结构，不阻塞打开文档', () => {
    const dir = tempDir()
    const store = new AnnotationStore({ annotationStorePath: dir })
    const file = store.fileForPath(DOC) as string

    writeFileSync(file, '   ')
    expect(store.load(DOC).annotations).toEqual([])

    writeFileSync(file, '{ not json')
    expect(store.load(DOC).annotations).toEqual([])
  })
})

describe('AnnotationStore — 条目级合并', () => {
  it('同 id 以传入版本为准，磁盘上被删掉的条目不会复活', () => {
    const merged = mergeAnnotations(
      [annotation({ note: '磁盘旧备注' }), annotation({ id: 'gone' })],
      [annotation({ note: '新备注' })]
    )
    expect(merged.map((a) => a.id)).toEqual(['a1'])
    expect(merged[0].note).toBe('新备注')
  })

  it('传入版本缺省的字段保留磁盘值（不完整的写入不会抹掉归档时间）', () => {
    const merged = mergeAnnotations(
      [annotation({ archived: true, archivedAt: 1234, currentText: '命中文本' })],
      [annotation({ note: '只改了备注', archivedAt: undefined })]
    )
    expect(merged[0].archivedAt).toBe(1234)
    expect(merged[0].currentText).toBe('命中文本')
    expect(merged[0].note).toBe('只改了备注')
  })

  it('磁盘上没有的新条目直接收下', () => {
    const merged = mergeAnnotations([], [annotation({ id: 'fresh' })])
    expect(merged.map((a) => a.id)).toEqual(['fresh'])
  })
})

describe('AnnotationStore — 迁移用并集合并', () => {
  it('目标原有条目保留、源条目追加（源不整份顶掉目标）', () => {
    const merged = mergeUnion(
      [annotation({ id: 'src', note: '被移入' })],
      [annotation({ id: 'dst', note: '目标原有' })]
    )
    expect(merged.map((a) => a.id)).toEqual(['dst', 'src'])
    expect(merged.map((a) => a.note)).toEqual(['目标原有', '被移入'])
  })

  it('同 id 冲突取 updatedAt 新的', () => {
    const sourceNewer = mergeUnion(
      [annotation({ id: 'a1', note: '源较新', updatedAt: 20 })],
      [annotation({ id: 'a1', note: '目标较旧', updatedAt: 10 })]
    )
    expect(sourceNewer).toHaveLength(1)
    expect(sourceNewer[0].note).toBe('源较新')

    const targetNewer = mergeUnion(
      [annotation({ id: 'a1', note: '源较旧', updatedAt: 10 })],
      [annotation({ id: 'a1', note: '目标较新', updatedAt: 20 })]
    )
    expect(targetNewer).toHaveLength(1)
    expect(targetNewer[0].note).toBe('目标较新')
  })
})

describe('AnnotationStore — 历史容量修剪', () => {
  it('超过轮数上限：按 round 最旧的整轮丢弃（当前列表永不丢）', () => {
    const live = annotation({ id: 'live' })
    const archived = [0, 1, 2, 3].map((round) =>
      annotation({ id: `h${round}`, archived: true, round, archivedAt: round })
    )
    const kept = pruneAnnotations([live, ...archived], 2, MAX_HISTORY_ENTRIES)

    expect(kept.map((a) => a.id)).toEqual(['live', 'h2', 'h3'])
  })

  it('超过条数上限：按 archivedAt 最旧的丢弃', () => {
    const archived = [10, 30, 20].map((at) =>
      annotation({ id: `at${at}`, archived: true, round: 1, archivedAt: at })
    )
    const kept = pruneAnnotations([annotation({ id: 'live' }), ...archived], MAX_HISTORY_ROUNDS, 2)

    expect(kept.map((a) => a.id)).toEqual(['live', 'at30', 'at20'])
  })

  it('没有归档条目时原样返回', () => {
    const list = [annotation(), annotation({ id: 'b' })]
    expect(pruneAnnotations(list)).toHaveLength(2)
  })
})

describe('AnnotationStore — 改名迁移', () => {
  it('把标注搬到新路径的 key 下，并改写文件内的 pathname', () => {
    const dir = tempDir()
    const store = new AnnotationStore({ annotationStorePath: dir })
    const to = '/tmp/docs/PRD-renamed.md'

    store.save({ pathname: DOC, round: 2, annotations: [annotation()] })
    expect(store.migratePath({ from: DOC, to })).toEqual({ ok: true })

    expect(store.load(DOC).annotations).toEqual([])
    const moved = store.load(to)
    expect(moved.pathname).toBe(to)
    expect(moved.round).toBe(2)
    expect(moved.annotations.map((a) => a.id)).toEqual(['a1'])
    expect(readdirSync(dir)).toEqual([`${docKey(to)}.json`])
  })

  it('源文件不存在 / from===to 时幂等返回 ok', () => {
    const store = new AnnotationStore({ annotationStorePath: tempDir() })
    expect(store.migratePath({ from: '/tmp/none.md', to: '/tmp/other.md' })).toEqual({ ok: true })
    expect(store.migratePath({ from: DOC, to: DOC })).toEqual({ ok: true })
  })

  it('迁移后新路径的保存不会覆盖历史（合并基于新 key 的文件）', () => {
    const dir = tempDir()
    const store = new AnnotationStore({ annotationStorePath: dir })
    const to = '/tmp/docs/PRD-2.md'

    store.save({ pathname: DOC, round: 1, annotations: [annotation({ note: '旧' })] })
    store.migratePath({ from: DOC, to })
    store.save({ pathname: to, round: 2, annotations: [annotation({ note: '新' })] })

    expect(store.load(to).annotations[0].note).toBe('新')
  })

  // 另存为 / 重命名到一个**已有标注**的路径：目标文件里积累的标注必须留下。
  // 修复前是「源整份顶掉目标」+「目标文件被 unlink 源之后的写入覆盖」，目标标注
  // 从盘上消失且不可恢复。
  it('目标路径已有标注：并集保留两侧，轮次取较大值', () => {
    const dir = tempDir()
    const store = new AnnotationStore({ annotationStorePath: dir })
    const to = '/tmp/docs/PRD-existing.md'

    store.save({
      pathname: DOC,
      round: 2,
      annotations: [annotation({ id: 'src', note: '被移入' })]
    })
    store.save({
      pathname: to,
      round: 5,
      annotations: [annotation({ id: 'dst', note: '目标原有' })]
    })

    expect(store.migratePath({ from: DOC, to })).toEqual({ ok: true })

    const moved = store.load(to)
    expect(moved.pathname).toBe(to)
    expect(moved.annotations.map((a) => a.id)).toEqual(['dst', 'src'])
    expect(moved.annotations.map((a) => a.note)).toEqual(['目标原有', '被移入'])
    // 轮次取两者较大值：两边的历史条目共用一套编号，取小会让新轮次与已有历史撞号
    expect(moved.round).toBe(5)
    // 源文件已删除，目录里只剩目标那一份
    expect(readdirSync(dir)).toEqual([`${docKey(to)}.json`])
    expect(store.load(DOC).annotations).toEqual([])
  })

  it('迁移后的保存不会把目标原有的标注抹掉（内存表若只带源条目就会）', () => {
    const dir = tempDir()
    const store = new AnnotationStore({ annotationStorePath: dir })
    const to = '/tmp/docs/PRD-existing-2.md'

    store.save({ pathname: DOC, round: 1, annotations: [annotation({ id: 'src' })] })
    store.save({ pathname: to, round: 1, annotations: [annotation({ id: 'dst' })] })
    store.migratePath({ from: DOC, to })

    // 渲染层迁移后会把盘上那份并集读回内存再落盘（见 store 的 MIGRATE_PATH）；
    // 这里模拟「拿并集落盘」这一步，断言目标条目仍在。
    const merged = store.load(to)
    store.save({ pathname: to, round: merged.round, annotations: merged.annotations })

    expect(store.load(to).annotations.map((a) => a.id)).toEqual(['dst', 'src'])
  })
})
