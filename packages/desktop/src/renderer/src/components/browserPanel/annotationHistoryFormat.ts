import { t } from '../../i18n'
import type { IAnnotationSnapshot } from '@shared/types/ipc'
import type { IDiffSegment } from '@muyajs/core/annotation/snapshotCompare'

/**
 * 历史对比的展示文案（纯函数，便于单测）：块类型标签、逐字差异压缩。
 */

/** 最近一层列表容器（任务项里嵌套的普通列表按普通列表算）。 */
const nearestList = (trail: string[]): string => {
  for (let i = trail.length - 1; i >= 0; i--) {
    const name = trail[i]
    if (name === 'bullet-list' || name === 'order-list' || name === 'task-list') return name
  }
  return ''
}

/**
 * 块类型标签：「标题 H2」「有序列表」「表格 · 第 2 行」「引用 › 列表」「代码块 · ts」。
 *
 * v2 反推的段落其实是「容器未知」（可能在列表 / 引用里），默认不出标签以免误导；
 * `force` 用于「块类型 A → B」这种必须给出两端名字的场合。
 */
export function snapshotKindLabel(
  snapshot: IAnnotationSnapshot | null | undefined,
  force = false
): string {
  if (!snapshot) return ''
  if (snapshot.legacy && snapshot.kind === 'paragraph' && !force) return ''

  const trail = Array.isArray(snapshot.trail) ? snapshot.trail : []
  let label: string
  switch (snapshot.kind) {
    case 'heading':
      label = t('annotation.compare.kind.heading', { level: snapshot.level ?? 1 })
      break
    case 'list':
      label =
        nearestList(trail) === 'order-list'
          ? t('annotation.compare.kind.orderedList')
          : t('annotation.compare.kind.list')
      break
    case 'task':
      label = snapshot.checked
        ? t('annotation.compare.kind.taskDone')
        : t('annotation.compare.kind.task')
      break
    case 'table':
      label =
        !snapshot.cell || snapshot.cell.row === 0
          ? t('annotation.compare.kind.tableHead')
          : t('annotation.compare.kind.tableRow', { row: snapshot.cell.row })
      break
    case 'code':
      label = snapshot.lang
        ? t('annotation.compare.kind.codeLang', { lang: snapshot.lang })
        : t('annotation.compare.kind.code')
      break
    default:
      label = t(`annotation.compare.kind.${snapshot.kind}`)
  }

  if (snapshot.kind !== 'quote' && trail.includes('block-quote')) {
    label = t('annotation.compare.kind.inQuote', { kind: label })
  }
  return label
}

/** 相同片段超过这个长度就折叠中间（只留贴着改动的两头）。 */
const EQUAL_KEEP = 18

/**
 * 压缩逐字差异：长段相同文字只留贴近改动的头尾（中间用 … 代替），让改动点
 * 在窄栏里一眼可见。首段只留尾、末段只留头。
 */
export function compactDiff(segments: IDiffSegment[] | null): IDiffSegment[] {
  if (!segments?.length) return []
  if (!segments.some((segment) => segment.op !== 0)) return []

  return segments.map((segment, index) => {
    if (segment.op !== 0) return segment
    const chars = Array.from(segment.text)
    const isFirst = index === 0
    const isLast = index === segments.length - 1
    if (isFirst && chars.length > EQUAL_KEEP) {
      return { op: 0, text: `…${chars.slice(-EQUAL_KEEP).join('')}` }
    }
    if (isLast && chars.length > EQUAL_KEEP) {
      return { op: 0, text: `${chars.slice(0, EQUAL_KEEP).join('')}…` }
    }
    if (!isFirst && !isLast && chars.length > EQUAL_KEEP * 2 + 1) {
      return {
        op: 0,
        text: `${chars.slice(0, EQUAL_KEEP).join('')} … ${chars.slice(-EQUAL_KEEP).join('')}`
      }
    }
    return segment
  })
}
