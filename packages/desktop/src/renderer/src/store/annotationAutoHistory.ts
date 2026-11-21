import type { IAnnotation, IAnnotationInspection } from '@shared/types/ipc'
import type { THistoryStatus } from './annotation'

/**
 * 外部批量改动后自动切到历史那一轮（feat/annotation-history-compare 第三轮）。
 *
 * 这里只放**纯函数与阈值**：候选轮次、检视指纹、「算不算批量改动」的判定。
 * 计时、交互暂缓、面板切换都在 annotation store 里，单测直接测这里。
 *
 * 判定的核心是**「这次外部修改前后」的对比**，而不是「标注时 vs 现在」：
 * 后者会把早就改过、用户也早就看过的条目在每次外部保存时重复算进去
 * （例如 git 切分支、别的工具顺手格式化文件），导致反复跳历史。
 * 前后对比用的是同一个引擎检视结果的指纹（见 inspectionFingerprint）。
 */

/** 只看最近几轮复制（agent 手里的通常就是最近一两轮）。 */
export const AUTO_HISTORY_MAX_ROUNDS = 3
/** 候选条目上限：最近一轮总是完整纳入，更早的轮次凑满这个数为止。 */
export const AUTO_HISTORY_MAX_ITEMS = 60
/** 批量判定：这一轮至少有这么多条被本次外部修改改动…… */
export const AUTO_HISTORY_MIN_CHANGED = 2
/** ……或者这一轮本来就很小（≤ 这么多条）且改到了其中至少 1 条。 */
export const AUTO_HISTORY_SMALL_ROUND = 2

/** 计入「被改动」的对比态：改字 / 改格式 / 改块类型、整句改写、删除。 */
const COUNTED: ReadonlySet<THistoryStatus> = new Set(['changed', 'rewritten', 'deleted'])

/**
 * 一条检视结果的指纹：外部修改前后指纹不同 = 这次修改碰到了这条标注。
 *
 * 只取「现在的样子」（命中方式 + 现在所在块的 markdown + 标注段在块内的区间），
 * 不取位置：前面插了几段导致整体下移，不算改动。
 */
export function inspectionFingerprint(inspection: IAnnotationInspection | undefined): string {
  if (!inspection) return ''
  const snapshot = inspection.snapshot
  return [
    inspection.match,
    snapshot?.markdown ?? '',
    snapshot?.markStart ?? '',
    snapshot?.markEnd ?? ''
  ].join('\u0001')
}

export interface AutoHistoryRound {
  round: number
  items: IAnnotation[]
}

/**
 * 候选轮次：最近 AUTO_HISTORY_MAX_ROUNDS 轮真正复制过的（round ≥ 1；第 0 组是
 * 「没复制就归档」的条目，从没发给过 agent）。最近一轮完整纳入，更早的轮次在
 * 不超过 AUTO_HISTORY_MAX_ITEMS 条的前提下整轮纳入。全局备注不检视。
 *
 * @param groups 历史分组，轮次大的在前（即 store.historyGroups）。
 */
export function pickCandidateRounds(
  groups: Array<{ round: number; items: IAnnotation[] }>
): AutoHistoryRound[] {
  const picked: AutoHistoryRound[] = []
  let total = 0
  for (const group of groups) {
    if (picked.length >= AUTO_HISTORY_MAX_ROUNDS) break
    if (!(group.round >= 1)) continue
    const items = group.items.filter((a) => !a.global)
    if (!items.length) continue
    if (picked.length && total + items.length > AUTO_HISTORY_MAX_ITEMS) break
    picked.push({ round: group.round, items })
    total += items.length
  }
  return picked
}

export interface AutoHistoryItemInput {
  id: string
  status: THistoryStatus
  /** 外部修改前的指纹；undefined = 没有基线（按「标注时 vs 现在」兜底）。 */
  before: string | undefined
  after: string
}

export interface AutoHistoryRoundInput {
  round: number
  items: AutoHistoryItemInput[]
}

export type AutoHistoryCounts = Record<'changed' | 'rewritten' | 'deleted', number>

export interface AutoHistoryDecision {
  /** 要切过去的那一轮。 */
  round: number
  /** 所有达到批量判定的轮次（新的在前）；都展开，只滚到 round。 */
  rounds: number[]
  /** round 这一轮里被本次修改改动的条目数（按对比态）。 */
  counts: AutoHistoryCounts
  /** round 这一轮里被本次修改改动的条目 id（卡片上标「本次」）。 */
  affectedIds: string[]
  /** round 这一轮参与判定的条目数（不含全局备注）。 */
  total: number
}

/** 一条历史标注算不算「被这次外部修改改动了」。 */
export function isAffected(item: AutoHistoryItemInput): boolean {
  if (!COUNTED.has(item.status)) return false
  // 没有基线：只能看「标注时 vs 现在」——已经改了就算。
  if (item.before === undefined) return true
  return item.before !== item.after
}

/** 一轮是否达到「批量改动」：≥ 2 条，或本来就只有 1–2 条且改到了 1 条。 */
export function isBatch(affected: number, total: number): boolean {
  if (affected >= AUTO_HISTORY_MIN_CHANGED) return true
  return affected >= 1 && total <= AUTO_HISTORY_SMALL_ROUND
}

/**
 * 判定这次外部修改要不要切到历史、切到哪一轮（纯函数）。
 *
 * - 每轮各自判定是否「批量改动」（isBatch）；
 * - 有多轮达标时，切到**改动条数最多**的那一轮，条数相同取**较新**的一轮
 *   （agent 手里最新的那份清单）；其余达标轮次一并展开；
 * - 没有一轮达标 → null（不打扰）。
 *
 * @param rounds 轮次大的在前（与 pickCandidateRounds 的顺序一致）。
 */
export function decideAutoHistory(rounds: AutoHistoryRoundInput[]): AutoHistoryDecision | null {
  const hits: AutoHistoryDecision[] = []
  for (const round of rounds) {
    const items = round.items.filter((item) => item.status !== 'global')
    const affected = items.filter(isAffected)
    if (!isBatch(affected.length, items.length)) continue
    const counts: AutoHistoryCounts = { changed: 0, rewritten: 0, deleted: 0 }
    for (const item of affected) counts[item.status as keyof AutoHistoryCounts] += 1
    hits.push({
      round: round.round,
      rounds: [],
      counts,
      affectedIds: affected.map((item) => item.id),
      total: items.length
    })
  }
  if (!hits.length) return null
  // hits 保持「新的在前」：严格大于才替换，同条数时保留较新的那轮。
  let best = hits[0]!
  for (const hit of hits) if (hit.affectedIds.length > best.affectedIds.length) best = hit
  return { ...best, rounds: hits.map((hit) => hit.round) }
}
