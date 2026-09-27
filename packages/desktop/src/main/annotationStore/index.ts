import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import writeFileAtomic from 'write-file-atomic'
import type {
  AnnotationDocument,
  AnnotationMigratePayload,
  AnnotationSavePayload,
  IAnnotation
} from '@shared/types/ipc'

/**
 * 内容标注落盘库（feat/annotations）。
 *
 * 结构对标 `main/editorBufferStore`：主进程持有目录，按需读写、原子写盘；
 * 但标注是**按文件路径绑定**的（不像 buffer store 按窗口 id），一个文档一个
 * 文件：`userData/annotations/<sha1(abspath)>.json`。
 *
 * 主进程只做三件事，不做任何业务判断（复制轮次、归档、失效分组全在渲染层）：
 *   1. 原子落盘（write-file-atomic：tmp + fsync + rename，断电不留半截文件）；
 *   2. 条目级合并——同一 id 的条目以传入版本为准，但保留磁盘上有、传入版本
 *      里缺省的字段（防一次不完整的写入把 archivedAt / currentText 抹掉）；
 *   3. 历史容量修剪——归档历史超过 20 轮 / 500 条时按 archivedAt 最旧丢弃。
 *
 * 「文件不存在」不是错误：渲染层据此得到空结构，从零开始。
 */

/** 落盘结构版本（方案 §5.2 冻结）。 */
export const ANNOTATION_FILE_VERSION = 2
/** 历史（已归档）保留的轮数上限。 */
export const MAX_HISTORY_ROUNDS = 20
/** 历史（已归档）保留的条目数上限。 */
export const MAX_HISTORY_ENTRIES = 500

export interface AnnotationStorePaths {
  annotationStorePath: string
}

/** 空文档结构（文件不存在 / 空路径 / 解析失败时的统一返回）。 */
export const emptyDocument = (pathname: string): AnnotationDocument => ({
  version: ANNOTATION_FILE_VERSION,
  pathname,
  round: 0,
  annotations: []
})

/**
 * 文档 key：sha1(绝对路径)。与文件的物理名一致，测试与迁移都以它为准。
 * 空路径（未保存文档）没有 key —— 未保存文档的标注只存内存，不落盘。
 */
export const docKey = (pathname: string): string | null => {
  if (typeof pathname !== 'string' || !pathname.trim()) return null
  return crypto.createHash('sha1').update(pathname).digest('hex')
}

/**
 * 条目级合并：以传入条目为基准（渲染层是数据的唯一写方，删除必须生效），
 * 磁盘上的同 id 条目只补传入版本里 `undefined` 的字段。
 *
 * 为什么不做「并集」：并集会让渲染层删除掉的条目在下次保存时复活。多窗口
 * 同开一份文档的并发场景下，本规则表现为「后写窗口为准」——已知取舍，见报告。
 */
export const mergeAnnotations = (disk: IAnnotation[], incoming: IAnnotation[]): IAnnotation[] => {
  const diskById = new Map<string, IAnnotation>()
  for (const entry of disk) {
    if (entry && typeof entry.id === 'string') diskById.set(entry.id, entry)
  }

  return incoming.map((entry) => {
    const previous = diskById.get(entry.id)
    if (!previous) return entry
    const merged = { ...previous } as Record<string, unknown>
    for (const [key, value] of Object.entries(entry)) {
      if (value === undefined) continue
      merged[key] = value
    }
    return merged as unknown as IAnnotation
  })
}

/**
 * 历史容量修剪：只修剪**已归档**条目（当前列表永不自动丢弃）。
 *
 * 先按轮次：归档条目按 `round` 分组，超过 `MAX_HISTORY_ROUNDS` 个轮次时，
 * 丢弃轮次最小的那些组（`round` 缺省=未复制即归档，归 0，属最旧）。
 * 再按条数：归档条目超过 `MAX_HISTORY_ENTRIES` 时，按 `archivedAt` 升序丢弃
 * 最旧的（缺 `archivedAt` 视为 0，最先被丢）。
 */
export const pruneAnnotations = (
  annotations: IAnnotation[],
  maxRounds = MAX_HISTORY_ROUNDS,
  maxEntries = MAX_HISTORY_ENTRIES
): IAnnotation[] => {
  const live = annotations.filter((entry) => !entry.archived)
  let archived = annotations.filter((entry) => entry.archived)

  if (!archived.length) return live

  const roundOf = (entry: IAnnotation): number =>
    typeof entry.round === 'number' && Number.isFinite(entry.round) ? entry.round : 0
  const archivedAtOf = (entry: IAnnotation): number =>
    typeof entry.archivedAt === 'number' && Number.isFinite(entry.archivedAt) ? entry.archivedAt : 0

  const rounds = [...new Set(archived.map(roundOf))].sort((a, b) => a - b)
  if (rounds.length > maxRounds) {
    const kept = new Set(rounds.slice(rounds.length - maxRounds))
    archived = archived.filter((entry) => kept.has(roundOf(entry)))
  }

  if (archived.length > maxEntries) {
    archived = [...archived].sort((a, b) => archivedAtOf(b) - archivedAtOf(a)).slice(0, maxEntries)
  }

  return [...live, ...archived]
}

export default class AnnotationStore {
  annotationStorePath: string

  constructor(paths: AnnotationStorePaths) {
    this.annotationStorePath = paths.annotationStorePath
    this.init()
  }

  init(): void {
    if (!fs.existsSync(this.annotationStorePath)) {
      fs.mkdirSync(this.annotationStorePath, { recursive: true })
    }
  }

  /** 绝对路径 → 标注文件路径（空路径返回 null）。 */
  fileForPath(pathname: string): string | null {
    const key = docKey(pathname)
    if (!key) return null
    return path.join(this.annotationStorePath, `${key}.json`)
  }

  /**
   * 读一个文档的标注。文件不存在 / 空文件 / 解析失败 / 版本不认识 → 返回空结构
   * （标注是辅助数据，坏文件不该阻塞打开文档）。
   */
  load(pathname: string): AnnotationDocument {
    const filePath = this.fileForPath(pathname)
    if (!filePath || !fs.existsSync(filePath)) return emptyDocument(pathname)

    try {
      const content = fs.readFileSync(filePath, 'utf8')
      if (!content.trim()) return emptyDocument(pathname)
      const parsed = JSON.parse(content) as Partial<AnnotationDocument>
      if (!parsed || !Array.isArray(parsed.annotations)) return emptyDocument(pathname)
      return {
        version: ANNOTATION_FILE_VERSION,
        pathname,
        docHash: parsed.docHash,
        round: typeof parsed.round === 'number' && Number.isFinite(parsed.round) ? parsed.round : 0,
        updatedAt: parsed.updatedAt,
        annotations: parsed.annotations as IAnnotation[]
      }
    } catch (error) {
      console.error(
        '[annotationStore] Failed to read annotation file, using empty document.',
        error
      )
      return emptyDocument(pathname)
    }
  }

  /** 落盘（未保存文档的空路径直接跳过：标注只存内存）。 */
  save(payload: AnnotationSavePayload): { ok: true } {
    const filePath = this.fileForPath(payload.pathname)
    if (!filePath) return { ok: true }

    const disk = this.load(payload.pathname)
    const merged = mergeAnnotations(disk.annotations, payload.annotations ?? [])
    const document: AnnotationDocument = {
      version: ANNOTATION_FILE_VERSION,
      pathname: payload.pathname,
      docHash: payload.docHash,
      round: typeof payload.round === 'number' ? payload.round : 0,
      updatedAt: Date.now(),
      annotations: pruneAnnotations(merged)
    }

    try {
      // 原子写：write-file-atomic 写临时文件 → fsync → rename 覆盖目标，
      // 崩溃/断电不会留下半截 JSON（与 editorBufferStore 同一取舍）。
      writeFileAtomic.sync(filePath, JSON.stringify(document), 'utf8')
    } catch (error) {
      console.error('[annotationStore] Failed to write annotation file.', error)
    }
    return { ok: true }
  }

  /**
   * 改名 / 另存为：把旧路径的标注文件挪到新路径的 key 下（同时改写文件内的
   * pathname）。源文件不存在或 from==to 时视为已完成（幂等，返回 ok:true）。
   */
  migratePath({ from, to }: AnnotationMigratePayload): { ok: boolean } {
    const fromPath = this.fileForPath(from)
    const toPath = this.fileForPath(to)
    if (!fromPath || !toPath || from === to) return { ok: true }
    if (!fs.existsSync(fromPath)) return { ok: true }
    if (fromPath === toPath) return { ok: true }

    try {
      const document = this.load(from)
      document.pathname = to
      document.updatedAt = Date.now()
      writeFileAtomic.sync(toPath, JSON.stringify(document), 'utf8')
      fs.unlinkSync(fromPath)
      return { ok: true }
    } catch (error) {
      console.error('[annotationStore] Failed to migrate annotation file.', error)
      return { ok: false }
    }
  }
}
