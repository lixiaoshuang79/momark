import { computed, markRaw, ref, shallowRef, toRaw, watch } from 'vue'
import { defineStore } from 'pinia'
import notice from '../services/notification'
import { t } from '../i18n'
import type {
  AnnotationDocument,
  IAnnotation,
  IAnnotationExportItem,
  IAnnotationInspection,
  IAnnotationReveal,
  IAnnotationSnapshot,
  TAnnotationRevealStatus
} from '@shared/types/ipc'
import { originSnapshotOf } from '@muyajs/core/annotation/snapshot'
import {
  compareSnapshots,
  type ISnapshotComparison,
  type TCompareStatus
} from '@muyajs/core/annotation/snapshotCompare'
import {
  normalizePhrase,
  normalizePhraseList,
  QUICK_PHRASE_MAX_COUNT,
  QUICK_PHRASE_MAX_LEN
} from '@muyajs/core/annotation/quickPhrase'
import { useBrowserPanelStore, type BpMode } from './browserPanel'
import {
  decideAutoHistory,
  inspectionFingerprint,
  pickCandidateRounds,
  type AutoHistoryDecision,
  type AutoHistoryRound
} from './annotationAutoHistory'
import { usePreferencesStore } from './preferences'
import { motionReduced } from '../util/motion'

/**
 * 内容标注 store（feat/annotations，方案 §5.1 / 契约冻结接口）。
 *
 * 职责分工：**引擎是标注的唯一权威**（锚点、重定位、行号、导出都在
 * `packages/muya/src/annotation/`），本 store 负责
 *   1. 按文件路径缓存标注表 + 复制轮次（未保存文档只存内存）；
 *   2. 通过 `mt::annotation::*` 三个 IPC 落盘（debounce 800ms，见 §5.5）；
 *   3. 面板所需的派生态（计数、历史分组、序号）；
 *   4. 复制文本的生成（`buildCopyText`，纯函数，模板见方案 §4.1）。
 *
 * 引擎经 `attachEngine(muya)` 挂进来，所有引擎调用都走可选链——引擎未挂载
 * 时面板仍可渲染已加载的数据、可查看历史，只是不能新增/定位/复制。
 */

/** 一个文档的缓存。key = 绝对路径；未保存文档用 `untitled:<tabId>`。 */
interface AnnotationDocCache {
  /** 下一次复制要用的轮次（1 起；复制后自增）。 */
  round: number
  annotations: IAnnotation[]
  docHash?: string
  /** 是否已从主进程读过盘（未保存文档直接置 true）。 */
  loaded: boolean
}

const UNTITLED_PREFIX = 'untitled:'

const isRealPath = (key: string | null): key is string => !!key && !key.startsWith(UNTITLED_PREFIX)

/** 交付给引擎的快照类型（引擎侧 TSelectionSnapshot，桌面不解释内部结构）。 */
export type TSelectionSnapshot = unknown

/**
 * 引擎「保存成功」事件（`muya-annotation-saved`）的桌面表示（feat/quick-phrases）。
 * `origin` 是保存按钮 / 卡片中心的**视口坐标**（供飞点动画取起点；引擎给不出时
 * 为 null，飞点不播）；`mode` 区分 chip 直标与手写保存；`seq` 让「同一坐标连续
 * 两次保存」也能被 watch 感知；`at` 供面板新条目入场判断「刚保存过」的时间窗。
 */
export interface AnnotationSavedSignal {
  origin: { x: number; y: number } | null
  mode: 'chip' | 'manual'
  at: number
  seq: number
}

// ═══════════════════════════════════════════════════════════════════
// 复制文本（方案 §4.1 模板 / §4.4 转义与截断）
// ═══════════════════════════════════════════════════════════════════

/** 条目之间的分隔线（32 个 U+2500，与方案 §4.1 逐字一致）。 */
const SEPARATOR = '─'.repeat(32)
/** 引文截断阈值与保留字数（§4.4.4）。 */
const QUOTE_LIMIT = 500
const QUOTE_HEAD = 240
const QUOTE_TAIL = 240
/** 「所在段落」截断阈值与保留字数（§4.4.4）。 */
const BLOCK_LIMIT = 300
const BLOCK_HEAD = 150
const BLOCK_TAIL = 150

/**
 * 围栏长度自适应（§4.4.1）：长度 = max(3, 内容中最长连续反引号串 + 1)。
 * 引文里出现三个反引号时自动升到 4/5 个，绝不「硬用三个」。
 * 不做任何 markdown 转义：引文在围栏内，`*` `_` `>` `|` `#` 原样保留。
 */
export const fenceFor = (content: string): string => {
  const runs = content.match(/`+/g)
  const longest = runs ? runs.reduce((max, run) => Math.max(max, run.length), 0) : 0
  return '`'.repeat(Math.max(3, longest + 1))
}

const truncateQuote = (quote: string): { text: string; truncated: boolean } => {
  if (quote.length <= QUOTE_LIMIT) return { text: quote, truncated: false }
  return {
    text: `${quote.slice(0, QUOTE_HEAD)}…（中间省略 ${quote.length - QUOTE_HEAD - QUOTE_TAIL} 字）…${quote.slice(-QUOTE_TAIL)}`,
    truncated: true
  }
}

const truncateBlock = (blockText: string): string => {
  if (blockText.length <= BLOCK_LIMIT) return blockText
  return `${blockText.slice(0, BLOCK_HEAD)}…${blockText.slice(-BLOCK_TAIL)}`
}

/** `[1] 第三章 需求说明 › 3.2 权限模型 ｜ L128–L130` 的抬头一行。 */
const headline = (item: IAnnotationExportItem, order: number): string => {
  // 全局备注：没有正文位置——抬头直接写语义标签，不写章节/行号（用户拍板：
  // 这类条目不出现「（未记录章节）」式的机器占位）。
  if (item.global) {
    return `[${order}] 全局备注`
  }
  const section = item.headingPath.length ? item.headingPath.join(' › ') : '（无章节）'
  let line = ''
  if (typeof item.lineStart === 'number' && typeof item.lineEnd === 'number') {
    // 单行时不写「L3–L3」这种原地往返（用户拍板：文本要精简）。
    line =
      item.lineStart === item.lineEnd
        ? ` ｜ L${item.lineStart}`
        : ` ｜ L${item.lineStart}–L${item.lineEnd}`
  } else if (typeof item.lineStart === 'number') {
    line = ` ｜ L${item.lineStart}`
  }
  return `[${order}] ${section}${line}`
}

/**
 * 是否该省掉动效（系统「减少动态效果」）。每次现查而不是缓存模块加载时的
 * 快照——用户在系统设置里中途改掉要能立刻生效。标注的飞点 / 徽标弹跳 / 条目入场
 * 都经它降级。
 */
export const prefersReducedMotion = motionReduced

/**
 * 生成交给 agent 的复制文本（**纯函数**，单测覆盖）。
 *
 * 抬头只写文件与条目数——**不写轮次**：轮次是墨记内部的记账，写进去既无助
 * 于定位，还会和「对话里的第几轮」混淆（方案 §4.3）。全文也不出现标注 id、
 * 时间戳、应用名与任何 emoji（§4.4.6）。
 *
 * @param items 引擎导出的结构化条目（含批量行号）；`orphaned` 的走文末附录。
 * @param pathname 文档绝对路径（agent 的 cwd 未必是文档目录，给全避免往返）。
 */
export const buildCopyText = (items: IAnnotationExportItem[], pathname: string): string => {
  const main = items.filter((item) => !item.orphaned)
  const orphaned = items.filter((item) => item.orphaned)
  const out: string[] = []

  out.push('【文档标注】')
  // 未保存文档没有可交给 agent 的路径：不能把内部 key（`untitled:<tabId>`）写出去
  // ——那既是**不存在的路径**、又把内部标识泄漏给外部模型——改为一句明确的标注。
  // 调用方负责把「非真实路径」归一成空串（见 `copyAll`）。
  out.push(pathname ? `文件：${pathname}` : '文件：（未保存文档，尚未落盘）')
  out.push(`共 ${main.length} 条`)
  // 只留信息性声明（定位依据 + 行号时效）。不写「请逐条修改」「只改被标注的位置」
  // 这类指令句——用户拍板：文本要精简，教 agent 做事的表述不要出现。
  out.push('定位以「原文」为准；行号基于复制时的版本，可能已偏移。')

  main.forEach((item, index) => {
    out.push('')
    out.push(SEPARATOR)
    out.push(headline(item, index + 1))
    if (item.global) {
      // 全局备注：无正文位置——只写要求（没有原文/段落可引用）。
      out.push(`修改要求：${item.note}`)
      return
    }
    const quote = truncateQuote(item.quote)
    const fence = fenceFor(quote.text)
    out.push('原文：')
    out.push(`${fence}text`)
    out.push(quote.text)
    out.push(fence)
    if (quote.truncated && typeof item.lineStart === 'number' && typeof item.lineEnd === 'number') {
      // 截断的引文必须补全范围，否则 agent 无法判断到底漏了什么（§4.4.4）。
      out.push(
        `完整范围：L${item.lineStart}–L${item.lineEnd}（共 ${item.lineEnd - item.lineStart + 1} 行）`
      )
    }
    // 所在段落：给出边界与格式语境（列表项？引用块？表格？）。选区恰好等于
    // 整段时省略（§4.3）——此时它不带来任何新信息。
    const block = item.blockText ?? ''
    if (block && block !== item.quote) {
      const blockFence = fenceFor(truncateBlock(block))
      out.push('所在段落：')
      out.push(`${blockFence}markdown`)
      out.push(truncateBlock(block))
      out.push(blockFence)
    }
    if (item.fragment) {
      // 引文切断了行内标记（加粗/链接/行内代码），单独交代一句定位依据（§3.6）。
      // 只陈述事实、不给 agent 下指令（用户拍板「指令句不要」）。
      out.push('引文为片段，以所在段落为准。')
    }
    out.push(`修改要求：${item.note}`)
  })

  if (orphaned.length) {
    out.push('')
    out.push(`（另有 ${orphaned.length} 条标注的原文已不存在，见文末附录）`)
    out.push('')
    out.push(SEPARATOR)
    out.push('附录：原文已删除的标注')
    orphaned.forEach((item, index) => {
      const quote = truncateQuote(item.quote)
      const fence = fenceFor(quote.text)
      // 附录条目标 [A] [B] …，与正文的 [1] [2] 区分开。
      out.push(
        `[${String.fromCharCode(65 + index)}] ${item.headingPath.length ? item.headingPath.join(' › ') + ' ｜ ' : ''}原引文：`
      )
      out.push(`${fence}text`)
      out.push(quote.text)
      out.push(fence)
      out.push(`修改要求：${item.note}`)
    })
  }

  return out.join('\n')
}

// ═══════════════════════════════════════════════════════════════════
// 历史对比（feat/annotation-history-compare）
// ═══════════════════════════════════════════════════════════════════

/**
 * 历史条目的对比态：
 * - `unchanged / changed / rewritten / deleted` 来自引擎比对（见 snapshotCompare）；
 * - `pending`：还没拿到「现在」（引擎未挂载 / 尚未检视）；
 * - `global`：全局备注，没有正文可比。
 */
export type THistoryStatus = TCompareStatus | 'pending' | 'global'

export interface HistoryCompareItem {
  annotation: IAnnotation
  status: THistoryStatus
  /** 标注时的样子（真快照或 v2 反推）。 */
  origin: IAnnotationSnapshot | null
  /** 现在的样子（located / block 才有）。 */
  now: IAnnotationSnapshot | null
  match: IAnnotationInspection['match'] | null
  comparison: ISnapshotComparison | null
}

export interface HistoryCompareGroup {
  round: number
  at: number
  items: HistoryCompareItem[]
  summary: Record<THistoryStatus, number>
}

/** 一条历史标注的对比态（纯函数）。 */
export function compareHistoryItem(
  annotation: IAnnotation,
  inspection: IAnnotationInspection | undefined
): HistoryCompareItem {
  const base = { annotation, origin: null, now: null, match: null, comparison: null }
  if (annotation.global) return { ...base, status: 'global' }

  const origin = originSnapshotOf(annotation)
  if (!origin || !inspection) return { ...base, origin, status: 'pending' }

  const comparison = compareSnapshots(origin, inspection.match, inspection.snapshot)
  return {
    annotation,
    origin,
    now: inspection.snapshot,
    match: inspection.match,
    comparison,
    status: comparison.status
  }
}

const emptySummary = (): Record<THistoryStatus, number> => ({
  unchanged: 0,
  changed: 0,
  rewritten: 0,
  deleted: 0,
  pending: 0,
  global: 0
})

/**
 * 一轮里的条目排序：按复制文本里的序号（`[n]`，与发给 agent 的编号一致），
 * 旧数据没有序号的排在后面、按创建时间。
 */
export function sortRoundItems<T extends { annotation: IAnnotation }>(items: T[]): T[] {
  const indexOf = (a: IAnnotation): number =>
    typeof a.sentIndex === 'number' ? a.sentIndex : Number.MAX_SAFE_INTEGER
  return items
    .slice()
    .sort(
      (a, b) =>
        indexOf(a.annotation) - indexOf(b.annotation) ||
        a.annotation.createdAt - b.annotation.createdAt
    )
}

/**
 * 比对结果的记忆（P2：历史每刷新一次就对所有条目重跑 legacySnapshot 与 fast-diff）。
 *
 * 引擎对没变的条目返回**同一个**检视结果对象（见 AnnotationModule 的检视缓存），
 * 所以按检视结果对象记忆即可：同一条目、同一份「标注时」、同一份「现在」只比一次。
 * 旧条目（无 origin）的反推快照按锚点对象记忆，避免每次重新分词。
 */
const compareMemo = new WeakMap<
  object,
  { annotation: IAnnotation; origin: IAnnotationSnapshot | null; item: HistoryCompareItem }
>()
const legacyMemo = new WeakMap<object, { key: string; origin: IAnnotationSnapshot | null }>()

function memoOriginOf(annotation: IAnnotation): IAnnotationSnapshot | null {
  if (annotation.origin || annotation.global || !annotation.anchor) {
    return originSnapshotOf(annotation)
  }
  const anchor = toRaw(annotation.anchor)
  const key = `${annotation.createdAt}|${anchor.ranges?.[0]?.blockName ?? ''}`
  const hit = legacyMemo.get(anchor)
  if (hit && hit.key === key) return hit.origin
  const origin = originSnapshotOf(annotation)
  legacyMemo.set(anchor, { key, origin })
  return origin
}

function compareHistoryItemMemo(
  annotation: IAnnotation,
  inspection: IAnnotationInspection | undefined
): HistoryCompareItem {
  if (!inspection || annotation.global) return compareHistoryItem(annotation, inspection)
  const raw = toRaw(inspection)
  const origin = memoOriginOf(annotation)
  const hit = compareMemo.get(raw)
  if (hit && toRaw(hit.annotation) === toRaw(annotation) && hit.origin === origin) return hit.item
  const item = compareHistoryItem(
    origin && !annotation.origin ? { ...annotation, origin } : annotation,
    inspection
  )
  // 视图里仍要用原条目对象（备注 / 序号等字段的响应式读取）
  const result: HistoryCompareItem = { ...item, annotation }
  compareMemo.set(raw, { annotation, origin, item: result })
  return result
}

/** 历史分组 + 对比态 + 每轮摘要（纯函数，面板与单测共用）。 */
export function buildHistoryCompare(
  groups: Array<{ round: number; at: number; items: IAnnotation[] }>,
  inspections: Record<string, IAnnotationInspection>
): HistoryCompareGroup[] {
  return groups.map((group) => {
    const items = sortRoundItems(
      group.items.map((annotation) =>
        compareHistoryItemMemo(annotation, inspections[annotation.id])
      )
    )
    const summary = emptySummary()
    for (const item of items) summary[item.status] += 1
    return { round: group.round, at: group.at, items, summary }
  })
}

/** 标注面板的子视图（组件本地状态；store 只经 panelViewRequest 发请求）。 */
export type AnnotationPanelView = 'current' | 'history'

/** 自动切到历史之前的右栏状态（横幅「返回」按它恢复）。 */
export interface AutoHistoryPrevious {
  open: boolean
  annotationsTab: boolean
  mode: BpMode
  view: AnnotationPanelView
}

/** 已自动切过去、横幅正显示的那一次。 */
export interface AutoHistoryShown extends AutoHistoryDecision {
  key: string
  previous: AutoHistoryPrevious
  /** 切之前不在「标注 → 历史」：横幅给「返回」。 */
  restorable: boolean
  seq: number
}

// ═══════════════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════════════

export const useAnnotationStore = defineStore('annotation', () => {
  const preferencesStore = usePreferencesStore()

  /** 文档 key → 缓存。key 是绝对路径，或未保存文档的 `untitled:<tabId>`。 */
  const docs = ref<Record<string, AnnotationDocCache>>({})
  /** 主编辑区当前文档的 key（面板永远跟随主文档，方案 §3.6）。 */
  const activeKey = ref<string | null>(null)
  /** 当前定位/高亮的条目（1.2s 脉冲期间）。 */
  const activeId = ref<string | null>(null)
  /** 最近一次复制到剪贴板的全文（「已复制文本」抽屉）。空串 = 还没复制过。 */
  const copiedText = ref('')
  /** 引擎给的文档序号（id → index），面板序号与复制文本的 [n] 同源。 */
  const indexById = ref<Record<string, number>>({})

  // 引擎（`muya.annotation`）。未挂载时面板只读。
  let engine: { annotation?: unknown; eventCenter?: EngineEventCenter } | null = null

  const annotationModuleOf = (
    instance: unknown
  ): Record<string, (...args: unknown[]) => unknown> | null => {
    const module = (instance as { annotation?: unknown } | null)?.annotation as
      | Record<string, (...args: unknown[]) => unknown>
      | undefined
    return module ?? null
  }

  const annotationModule = (): Record<string, (...args: unknown[]) => unknown> | null =>
    annotationModuleOf(engine)

  // ── 引擎事件（muya.eventCenter，契约见 实现规格 §二）─────────────────
  // 引擎侧卡片经事件总线把「打开设置 / 存为常用语 / 保存成功」交给桌面。
  // 引擎未挂载时静默（事件只登记，绑定发生在 attachEngine）。
  type EngineListener = (...args: unknown[]) => void
  interface EngineEventCenter {
    subscribe?: (event: string, listener: EngineListener) => void
    off?: (event: string, listener: EngineListener) => void
  }

  const engineListeners: Array<{ event: string; listener: EngineListener }> = []
  // 监听器只登记一次、随引擎实例反复绑定：attachEngine 换实例（重新挂载 / 多
  // 编辑器）时先 off 旧实例再 subscribe 新实例，否则同一事件会触发两遍。
  let boundEventCenter: EngineEventCenter | null = null

  function onEngineEvent(event: string, listener: EngineListener): void {
    engineListeners.push({ event, listener })
    boundEventCenter?.subscribe?.(event, listener)
  }

  function bindEngineEvents(center: EngineEventCenter | null): void {
    if (center === boundEventCenter) return
    for (const { event, listener } of engineListeners) {
      boundEventCenter?.off?.(event, listener)
    }
    boundEventCenter = center
    if (!center) return
    for (const { event, listener } of engineListeners) {
      center.subscribe?.(event, listener)
    }
  }

  // ── 常用语（feat/quick-phrases）────────────────────────────────────
  /** 设置弹窗开关（本窗口模态；由卡片头 ⚙ 的引擎事件打开，弹窗与「完成」关闭）。 */
  const quickPhraseSettingsOpen = ref(false)
  /** 最近一次保存成功信号（飞点 / 面板新条目入场都从它起跳）。 */
  const savedPulse = ref<AnnotationSavedSignal | null>(null)
  /** 徽标弹跳脉冲：飞点到达时自增，bpModes 监听后播 1→1.22→1。 */
  const badgePulse = ref(0)
  let savedSeq = 0

  /** 偏好里的常用语（整表，顺序即键位顺序）。规范化只做「是字符串数组」这一层。 */
  const quickPhrases = (): string[] => {
    const raw = preferencesStore.annotationQuickPhrases
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  }

  /**
   * 「＋ 存为常用语」：把备注 push 进偏好（写盘）。空 / 重复 / 超长 / 已满 9 条
   * 一律静默丢弃——引擎侧按钮显隐已按同一组条件判定，这里是第二道防线：非法值
   * 会让主进程 electron-store 的 ajv 校验失败，整次偏好写入被拒。
   *
   * 规范化必须走引擎的 `normalizePhrase`：卡片判定 / 这里写入 / 回推引擎三处
   * 共用同一份规则（折叠含全角空格的连续空白）。桌面若按另一套（如只 trim）
   * 存盘，全角空格会让卡片误判「可采集」——按钮在、点了没反应、还回假回执。
   */
  function addQuickPhrase(raw: string): void {
    const phrase = normalizePhrase(raw)
    if (!phrase) return
    if (Array.from(phrase).length > QUICK_PHRASE_MAX_LEN) return
    // 既有表先整表规范化（丢空 / 去重 / 截断）：手改偏好留下的脏数据不参与
    // 去重比较，也顺手收敛，避免把脏表原样带回盘上。
    const list = normalizePhraseList(quickPhrases())
    if (list.includes(phrase)) return
    if (list.length >= QUICK_PHRASE_MAX_COUNT) return
    preferencesStore.SET_SINGLE_PREFERENCE({
      type: 'annotationQuickPhrases',
      value: [...list, phrase]
    })
  }

  // 卡片 ⚙ → 打开常用语设置弹窗（本窗口模态，卡片保持打开、不切偏好设置窗口）。
  onEngineEvent('muya-annotation-settings', () => {
    quickPhraseSettingsOpen.value = true
  })

  // 卡片「＋ 存为常用语」→ push 进偏好（去重 / 上限 9 / 长度见 addQuickPhrase）。
  onEngineEvent('muya-annotation-phrase-add', (payload) => {
    const phrase = (payload as { phrase?: unknown } | undefined)?.phrase
    if (typeof phrase === 'string') addQuickPhrase(phrase)
  })

  // 卡片保存成功 → 记一次信号。（origin 缺失按 null 处理：飞点不播，其余照常。）
  onEngineEvent('muya-annotation-saved', (payload) => {
    const data = payload as { origin?: unknown; mode?: unknown } | undefined
    const rawOrigin = data?.origin as { x?: unknown; y?: unknown } | null | undefined
    const rawX = rawOrigin?.x
    const rawY = rawOrigin?.y
    // `typeof === 'number'` 会放过 NaN / Infinity：那样的原点会把飞点画到屏幕外，
    // 按有限数判定（Number.isFinite 对非数字本身也返回 false）。
    const origin =
      Number.isFinite(rawX) && Number.isFinite(rawY)
        ? { x: rawX as number, y: rawY as number }
        : null
    savedPulse.value = {
      origin,
      // mode 未知（字段缺失 / 引擎旧版）按最保守的 manual 处理：chip 是明确已知的
      // 直标路径，拿它兜底会把一次普通保存放大成「直标回执」。
      mode: data?.mode === 'chip' ? 'chip' : 'manual',
      at: Date.now(),
      seq: ++savedSeq
    }
  })

  const enabled = computed(() => preferencesStore.annotationEnabled !== false)

  const docFor = (key: string | null): AnnotationDocCache | null =>
    key ? (docs.value[key] ?? null) : null

  const currentDoc = computed(() => docFor(activeKey.value))
  const annotations = computed<IAnnotation[]>(() => currentDoc.value?.annotations ?? [])
  /** 当前列表（未归档）。 */
  const currentList = computed(() => annotations.value.filter((a) => !a.archived))
  /** 历史（已归档），按 archivedAt 新的在前。 */
  const historyList = computed(() =>
    annotations.value
      .filter((a) => a.archived)
      .slice()
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  )

  const isOrphan = (a: IAnnotation): boolean => a.anchorState === 'orphaned'
  /** 未复制 = 未归档、没复制过、锚点还在。 */
  const pendingList = computed(() => currentList.value.filter((a) => !a.copied && !isOrphan(a)))
  const copiedList = computed(() => currentList.value.filter((a) => a.copied && !isOrphan(a)))
  const orphanList = computed(() => currentList.value.filter((a) => isOrphan(a)))

  const counts = computed(() => ({
    pending: pendingList.value.length,
    copied: copiedList.value.length,
    orphan: orphanList.value.length
  }))

  /** tab 徽标用的未复制计数。 */
  const uncopiedCount = computed(() => counts.value.pending)
  /** 未保存文档（标注只存内存）——面板顶部灰字提示用。 */
  const isUntitled = computed(() => !isRealPath(activeKey.value))

  /** 历史按轮次分组（轮次大的在前）。缺 round 的（未复制即归档）归 0 组。 */
  const historyGroups = computed(() => {
    const map = new Map<number, IAnnotation[]>()
    for (const annotation of historyList.value) {
      const round = typeof annotation.round === 'number' ? annotation.round : 0
      const bucket = map.get(round)
      if (bucket) bucket.push(annotation)
      else map.set(round, [annotation])
    }
    return [...map.entries()]
      .map(([round, items]) => ({
        round,
        items,
        at: Math.max(...items.map((a) => a.archivedAt ?? 0))
      }))
      .sort((a, b) => b.round - a.round)
  })

  // ── 历史对比：「现在」的样子（feat/annotation-history-compare）──────────
  /**
   * id → 引擎 `inspect()` 的结果。只在内存里、不落盘：「现在」随文档实时变化，
   * 存下来反而会过期。切文档时清空，历史真正可见时按需重算。
   *
   * shallowRef + markRaw：检视结果里带整张快照，深层响应式代理既无必要又慢；
   * 引擎对没变的条目返回同一个对象，原样保留引用才能让比对记忆命中。
   */
  const historyNow = shallowRef<Record<string, IAnnotationInspection>>({})
  /** 面板停在「历史」子视图（由 annotationMode 告知；不等于用户看得见）。 */
  const historyViewOpen = ref(false)
  /** 窗口是否在前台（最小化 / 切到别的桌面时不检视）。 */
  const pageVisible = ref(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  )
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      pageVisible.value = document.visibilityState !== 'hidden'
    })
  }
  /**
   * 历史**真正可见**：停在历史子视图 + 右栏展开 + 当前 tab 是标注 + 窗口在前台。
   *
   * 标注面板是 v-show 常驻挂载（browserPanel/index.vue），切到网页 / 文档 tab 或
   * 收起右栏都不会卸载组件——只看子视图会在用户根本看不到历史时继续每次停键
   * 全量检视（深审 P1）。
   */
  const historyVisible = computed(() => {
    if (!historyViewOpen.value || !pageVisible.value) return false
    const panel = useBrowserPanelStore()
    return panel.open !== false && panel.activeTab === 'annotation'
  })
  /** 用户展开着的轮次（检视时优先处理）；null = 还没告知，按「最新一轮」处理。 */
  let historyOpenRounds: number[] | null = null
  let historyTimer: ReturnType<typeof setTimeout> | null = null
  let historySliceTimer: ReturnType<typeof setTimeout> | null = null
  let historyPass = 0

  /** 一次主线程连续检视的时间预算（ms），超出就让出主线程、下一拍接着做。 */
  const HISTORY_SLICE_BUDGET = 12
  /** 每次调用 inspect 的条数（预算按批检查）。 */
  const HISTORY_SLICE_SIZE = 4

  const nowMs = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()

  /** 检视顺序：展开着的轮次在前（用户正看着），其余在后台补齐（组头摘要要用）。 */
  function historyQueue(): string[] {
    const groups = historyGroups.value
    const latest = groups[0]?.round
    const isOpen = (round: number): boolean =>
      historyOpenRounds ? historyOpenRounds.includes(round) : round === latest
    const first: string[] = []
    const rest: string[] = []
    for (const group of groups) {
      const bucket = isOpen(group.round) ? first : rest
      for (const annotation of group.items) if (!annotation.global) bucket.push(annotation.id)
    }
    return [...first, ...rest]
  }

  function cancelHistoryRefresh(): void {
    historyPass++
    if (historyTimer) {
      clearTimeout(historyTimer)
      historyTimer = null
    }
    if (historySliceTimer) {
      clearTimeout(historySliceTimer)
      historySliceTimer = null
    }
  }

  /**
   * 检视当前文档的历史条目（引擎侧只读、带缓存，见 AnnotationModule.inspect）。
   *
   * 分片：每片最多占用主线程 ~12ms，做不完就 setTimeout(0) 让出，下一片接着做；
   * 期间文档又变 / 历史被隐藏，整轮作废。上一轮已有的结果保留到被新结果覆盖，
   * 面板不会先闪成「待比对」。
   */
  function refreshHistoryNow(): void {
    cancelHistoryRefresh()
    const module = annotationModule()
    const ids = historyQueue()
    if (!module?.inspect || !ids.length) {
      if (Object.keys(historyNow.value).length) historyNow.value = {}
      return
    }
    const pass = historyPass
    const wanted = new Set(ids)
    const next: Record<string, IAnnotationInspection> = {}
    for (const [id, result] of Object.entries(historyNow.value)) {
      if (wanted.has(id)) next[id] = result
    }
    let cursor = 0

    const step = (): void => {
      historySliceTimer = null
      if (pass !== historyPass) return
      const started = nowMs()
      while (cursor < ids.length) {
        const slice = ids.slice(cursor, cursor + HISTORY_SLICE_SIZE)
        cursor += slice.length
        try {
          const results = (module.inspect(slice) as IAnnotationInspection[] | undefined) ?? []
          for (const result of results) {
            if (result && typeof result.id === 'string') next[result.id] = markRaw(result)
          }
        } catch (error) {
          console.error('[annotation] Failed to inspect history.', error)
        }
        if (nowMs() - started >= HISTORY_SLICE_BUDGET) break
      }
      historyNow.value = { ...next }
      if (cursor >= ids.length) rememberSeen(activeKey.value, fingerprintsOf(Object.values(next)))
      if (cursor < ids.length && historyVisible.value) {
        historySliceTimer = setTimeout(step, 0)
      }
    }

    step()
  }

  /** 节流版：文档每次变化都会触发，攒一下再检视。不可见时什么都不做。 */
  function scheduleHistoryRefresh(delay = 150): void {
    if (!historyVisible.value) return
    if (historyTimer) clearTimeout(historyTimer)
    historyTimer = setTimeout(() => {
      historyTimer = null
      if (historyVisible.value) refreshHistoryNow()
    }, delay)
  }

  let historyWasVisible = false
  /** 可见性变化的唯一出口：变可见立即检视一次，变不可见撤掉所有计时器与在途分片。 */
  function syncHistoryVisibility(): void {
    const visible = historyVisible.value
    if (visible === historyWasVisible) return
    historyWasVisible = visible
    if (visible) refreshHistoryNow()
    else cancelHistoryRefresh()
  }
  watch(historyVisible, syncHistoryVisibility)

  /** 面板切到 / 离开「历史」子视图（真正的可见性还要看右栏与 tab，见 historyVisible）。 */
  function SET_HISTORY_VIEW(open: boolean): void {
    historyViewOpen.value = open
    syncHistoryVisibility()
  }

  /** 面板告知用户展开着的轮次：下一次检视优先处理它们。 */
  function SET_HISTORY_OPEN_ROUNDS(rounds: number[]): void {
    historyOpenRounds = [...rounds]
  }

  // 应用内编辑：正文变了就重算（外部重载 / 切文档走下面的 annotations watch）。
  onEngineEvent('json-change', () => scheduleHistoryRefresh(600))

  // ── 历史定位（第二轮：点一条历史记录，跳到它现在在正文里的位置）──────────
  /** 刚被定位过的历史条目（卡片短暂高亮，与正文闪烁同步消失）。 */
  const historyFocusId = ref<string | null>(null)
  let historyFocusTimer: ReturnType<typeof setTimeout> | null = null
  const HISTORY_FOCUS_MS = 3600

  /**
   * 在正文里定位一条历史标注**现在**的位置：引擎滚动主编辑器并一次性闪烁该处
   * （不移动光标、不改条目、不落盘）。没有精确位置时按情况给出明确提示：
   * 整句改写 / 这一句被删 → 已指到原段落；连段落也没了 → 已指到原位置附近；
   * 都找不到 → 说明找不到；全局备注 → 没有正文位置。从不静默。
   */
  function revealHistory(id: string): TAnnotationRevealStatus | null {
    const target = findById(id)
    if (!target) return null
    const say = (key: string): void => {
      notice.notify({ message: t(key), type: 'info', time: 3000 })
    }
    if (target.global) {
      say('annotation.locate.global')
      return 'global'
    }
    const module = annotationModule()
    if (!module?.reveal) {
      say('annotation.toast.engineMissing')
      return null
    }
    let result: IAnnotationReveal | null = null
    try {
      result = (module.reveal(id, { smooth: !prefersReducedMotion() }) as IAnnotationReveal) ?? null
    } catch (error) {
      console.error('[annotation] Failed to reveal history item.', error)
    }
    if (!result) {
      say('annotation.toast.engineMissing')
      return null
    }
    // 顺带刷新这一条的「现在」：卡片与正文看到的是同一个位置。
    if (result.inspection) {
      historyNow.value = { ...historyNow.value, [id]: markRaw(result.inspection) }
    }
    historyFocusId.value = id
    if (historyFocusTimer) clearTimeout(historyFocusTimer)
    historyFocusTimer = setTimeout(() => {
      historyFocusTimer = null
      if (historyFocusId.value === id) historyFocusId.value = null
    }, HISTORY_FOCUS_MS)
    if (result.status !== 'range') say(`annotation.locate.${result.status}`)
    return result.status
  }

  /** 历史分组 + 对比态（面板直接渲染它）。 */
  const historyCompareGroups = computed(() =>
    buildHistoryCompare(historyGroups.value, historyNow.value)
  )

  // ── 外部批量改动后自动切到历史那一轮（第三轮）────────────────────────────
  //
  // 流程：外部重载（editor.ts loadChange）→ NOTE_EXTERNAL_RELOAD 在正文被替换**之前**
  // 检视最近几轮、记下指纹做基线 → 停 1.2s 没有新的重载（agent 连续保存）再检视一次
  // → 与基线比对、按阈值判定（annotationAutoHistory.ts）→ 达标就等用户「空下来」
  // （窗口在前台、1.5s 内没有按键 / 按住鼠标 / 输入法组字）再切右栏。
  //
  // 成本：只在外部重载后跑，只检视最近 3 轮（≤ 60 条），引擎侧检视只读带缓存；
  // 历史不可见时不会因此开始周期性检视（refreshHistoryNow 的可见性规则不变）。

  /** 偏好里的自动切换开关（标注总开关关掉时一并失效）。 */
  const autoHistoryEnabled = computed(
    () => enabled.value && preferencesStore.annotationAutoHistory !== false
  )

  /** 停这么久没有新的外部重载，才算 agent 这一下改完了。 */
  const EXTERNAL_SETTLE_MS = 1200
  /** 同一篇文档两次外部重载间隔不超过它，算同一次「agent 修改会话」，基线不换。 */
  const EXTERNAL_SESSION_MS = 10 * 60_000
  /** 用户最后一次按键 / 点按之后要空这么久才切（不在打字、拖选中途动右栏）。 */
  const AUTO_HISTORY_IDLE_MS = 1500
  /** 判定结果最多等这么久（窗口一直在后台 / 一直没切回那篇文档就作废）。 */
  const AUTO_HISTORY_HOLD_MS = 2 * 3600_000

  interface ExternalSession {
    /** 会话开始前的指纹（id → fingerprint）；null = 没有基线（后台文档且没检视过）。 */
    baseline: Record<string, string> | null
    lastAt: number
    /** 最近一次评估完成的时间（之后没有新重载就不必再评估）。 */
    evaluatedAt: number
    /** 本次会话已经自动切过的轮次：同一会话不对同一轮再切第二次。 */
    shown: Set<number>
  }
  const externalSessions = new Map<string, ExternalSession>()
  /** 每篇文档最近一次检视到的指纹（只在内存）：后台文档被外部修改时拿它当基线。 */
  const lastSeen = new Map<string, Record<string, string>>()

  /** 已经切过去、横幅正显示的那一次（面板渲染横幅 / 卡片「本次」标记用）。 */
  const autoHistory = ref<AutoHistoryShown | null>(null)
  let autoHistorySeq = 0
  /** 判定达标、还在等用户空下来 / 切回这篇文档 / 窗口回到前台。 */
  let pendingSwitch: { key: string; decision: AutoHistoryDecision; at: number } | null = null

  /**
   * 面板子视图的外部请求（annotationMode.vue 监听）：面板的「当前 / 历史」与轮次
   * 展开是组件本地状态，store 只发请求、不接管。
   */
  const panelViewRequest = ref<{
    seq: number
    view: AnnotationPanelView
    expandRounds?: number[]
    focusRound?: number
  } | null>(null)
  let panelViewSeq = 0
  function requestPanelView(
    request: Omit<NonNullable<typeof panelViewRequest.value>, 'seq'>
  ): void {
    panelViewRequest.value = { ...request, seq: ++panelViewSeq }
  }

  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let evalTimer: ReturnType<typeof setTimeout> | null = null
  let applyTimer: ReturnType<typeof setTimeout> | null = null
  let evalPass = 0

  // 交互观察：只在有外部修改待处理时挂监听（记时间戳，没有别的开销）。
  let lastInputAt = 0
  let pointerHeld = false
  let composing = false
  let interactionWatched = false
  const onInput = (): void => {
    lastInputAt = Date.now()
  }
  const onPointerDown = (): void => {
    pointerHeld = true
    onInput()
  }
  const onPointerUp = (): void => {
    pointerHeld = false
    onInput()
  }
  const onCompositionStart = (): void => {
    composing = true
    onInput()
  }
  const onCompositionEnd = (): void => {
    composing = false
    onInput()
  }
  const onWindowFocus = (): void => {
    // 回到墨记的那一下（多半伴随一次点击）不算「正在操作」：用户就是回来看结果的。
    tryApplyAutoHistory()
  }
  const INTERACTION_EVENTS: Array<[string, EventListener, EventTarget | null]> = []
  function watchInteraction(on: boolean): void {
    if (typeof window === 'undefined' || on === interactionWatched) return
    interactionWatched = on
    if (!INTERACTION_EVENTS.length) {
      INTERACTION_EVENTS.push(
        ['keydown', onInput, null],
        ['pointerdown', onPointerDown, null],
        ['pointerup', onPointerUp, null],
        ['pointercancel', onPointerUp, null],
        ['compositionstart', onCompositionStart, null],
        ['compositionend', onCompositionEnd, null],
        ['focus', onWindowFocus, null]
      )
    }
    for (const [event, listener] of INTERACTION_EVENTS) {
      if (on) window.addEventListener(event, listener, true)
      else window.removeEventListener(event, listener, true)
    }
    if (!on) {
      pointerHeld = false
      composing = false
    }
  }
  /** 没有待评估 / 待切换的外部修改了 → 撤掉交互监听。 */
  function releaseInteractionWatch(): void {
    if (!pendingSwitch && !settleTimer && !evalTimer) watchInteraction(false)
  }

  const windowFocused = (): boolean =>
    typeof document === 'undefined' ||
    typeof document.hasFocus !== 'function' ||
    document.hasFocus()

  function fingerprintsOf(
    results: Iterable<IAnnotationInspection | undefined>
  ): Record<string, string> {
    const out: Record<string, string> = {}
    for (const result of results) {
      if (result && typeof result.id === 'string') out[result.id] = inspectionFingerprint(result)
    }
    return out
  }

  function rememberSeen(key: string | null, fingerprints: Record<string, string>): void {
    if (!isRealPath(key) || !Object.keys(fingerprints).length) return
    lastSeen.set(key, { ...lastSeen.get(key), ...fingerprints })
  }

  /** 正文被替换之前，同步检视候选条目做基线（≤ 60 条，引擎检视只读带缓存）。 */
  function captureBaseline(): Record<string, string> | null {
    const module = annotationModule()
    const ids = pickCandidateRounds(historyGroups.value).flatMap((round) =>
      round.items.map((a) => a.id)
    )
    if (!module?.inspect || !ids.length) return null
    try {
      const results = (module.inspect(ids) as IAnnotationInspection[] | undefined) ?? []
      const fingerprints = fingerprintsOf(results)
      rememberSeen(activeKey.value, fingerprints)
      return fingerprints
    } catch (error) {
      console.error('[annotation] Failed to inspect history before reload.', error)
      return null
    }
  }

  function cancelExternalEval(): void {
    evalPass++
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    if (evalTimer) {
      clearTimeout(evalTimer)
      evalTimer = null
    }
  }

  function scheduleExternalEval(key: string): void {
    cancelExternalEval()
    watchInteraction(true)
    settleTimer = setTimeout(() => {
      settleTimer = null
      evaluateExternal(key)
    }, EXTERNAL_SETTLE_MS)
  }

  /**
   * 外部重载（editor.ts `loadChange`）**在正文被替换之前**调用。
   *
   * 当前文档：立即检视候选轮次做基线；后台文档：用这篇文档上次检视到的指纹做基线
   * （没有就按「标注时 vs 现在」兜底），等它被切到前台时再评估。agent 连续保存多次
   * 算同一个会话：基线保持会话开始前的样子，每次停下来都与它比，累计判定。
   */
  function NOTE_EXTERNAL_RELOAD(pathname: string): void {
    if (!autoHistoryEnabled.value || !isRealPath(pathname)) return
    const now = Date.now()
    let session = externalSessions.get(pathname)
    if (session && now - session.lastAt > EXTERNAL_SESSION_MS) session = undefined
    if (!session) {
      const isActive = pathname === activeKey.value
      const seen = lastSeen.get(pathname)
      session = {
        baseline: isActive ? captureBaseline() : seen ? { ...seen } : null,
        lastAt: now,
        evaluatedAt: 0,
        shown: new Set()
      }
      externalSessions.set(pathname, session)
    }
    session.lastAt = now
    if (pathname === activeKey.value) scheduleExternalEval(pathname)
  }

  /** 外部修改停下来之后：检视候选条目、与基线比对、判定（分片，不长时间占主线程）。 */
  function evaluateExternal(key: string): void {
    cancelExternalEval()
    const session = externalSessions.get(key)
    const module = annotationModule()
    if (!session || key !== activeKey.value || !autoHistoryEnabled.value || !module?.inspect) {
      releaseInteractionWatch()
      return
    }
    const rounds = pickCandidateRounds(historyGroups.value)
    const ids = rounds.flatMap((round) => round.items.map((a) => a.id))
    if (!ids.length) {
      releaseInteractionWatch()
      return
    }
    const pass = evalPass
    const results: Record<string, IAnnotationInspection> = {}
    let cursor = 0

    const step = (): void => {
      evalTimer = null
      if (pass !== evalPass || key !== activeKey.value) return
      const started = nowMs()
      while (cursor < ids.length) {
        const slice = ids.slice(cursor, cursor + HISTORY_SLICE_SIZE)
        cursor += slice.length
        try {
          const found = (module.inspect(slice) as IAnnotationInspection[] | undefined) ?? []
          for (const result of found) {
            if (result && typeof result.id === 'string') results[result.id] = markRaw(result)
          }
        } catch (error) {
          console.error('[annotation] Failed to inspect history after reload.', error)
        }
        if (nowMs() - started >= HISTORY_SLICE_BUDGET) break
      }
      if (cursor < ids.length) {
        evalTimer = setTimeout(step, 0)
        return
      }
      finishExternalEval(key, session, rounds, results)
    }
    step()
  }

  function finishExternalEval(
    key: string,
    session: ExternalSession,
    rounds: AutoHistoryRound[],
    results: Record<string, IAnnotationInspection>
  ): void {
    session.evaluatedAt = Date.now()
    const fingerprints = fingerprintsOf(Object.values(results))
    rememberSeen(key, fingerprints)
    // 顺手把检视结果交给历史：切过去时卡片直接有「现在」，不先闪「待比对」。
    historyNow.value = { ...historyNow.value, ...results }

    const decision = decideAutoHistory(
      rounds.map((round) => ({
        round: round.round,
        items: round.items.map((annotation) => ({
          id: annotation.id,
          status: compareHistoryItemMemo(annotation, results[annotation.id]).status,
          before: session.baseline ? session.baseline[annotation.id] : undefined,
          after: fingerprints[annotation.id] ?? ''
        }))
      }))
    )
    if (decision) {
      const shownNow = autoHistory.value
      if (session.shown.has(decision.round)) {
        // 同一会话已经切过这一轮：不再动面板，横幅还在就只更新计数。
        if (shownNow && shownNow.key === key && shownNow.round === decision.round) {
          autoHistory.value = { ...shownNow, ...decision, rounds: shownNow.rounds }
        }
      } else {
        pendingSwitch = { key, decision, at: Date.now() }
      }
    }
    tryApplyAutoHistory()
  }

  /** 还要等多久才算「用户空下来」（0 = 现在就可以切）。 */
  function interactionWait(): number {
    if (pointerHeld || composing || quickPhraseSettingsOpen.value) return AUTO_HISTORY_IDLE_MS
    return Math.max(0, lastInputAt + AUTO_HISTORY_IDLE_MS - Date.now())
  }

  /**
   * 判定达标后的「什么时候切」：
   * - 不是当前文档（用户在看别的文档）→ 等 SWITCH_DOC 切回来；
   * - 窗口在后台（用户还在终端里看 agent）→ 等窗口 focus，回来那一刻切；
   * - 正在打字 / 拖选 / 组字 / 开着常用语设置 → 等空下来 1.5s。
   */
  function tryApplyAutoHistory(): void {
    if (applyTimer) {
      clearTimeout(applyTimer)
      applyTimer = null
    }
    const pending = pendingSwitch
    if (!pending) {
      releaseInteractionWatch()
      return
    }
    if (!autoHistoryEnabled.value || Date.now() - pending.at > AUTO_HISTORY_HOLD_MS) {
      pendingSwitch = null
      releaseInteractionWatch()
      return
    }
    if (pending.key !== activeKey.value) return
    watchInteraction(true)
    if (!windowFocused()) return
    const wait = interactionWait()
    if (wait > 0) {
      applyTimer = setTimeout(() => {
        applyTimer = null
        tryApplyAutoHistory()
      }, wait)
      return
    }
    pendingSwitch = null
    releaseInteractionWatch()
    applyAutoHistory(pending.key, pending.decision)
  }

  /** 切过去：打开右栏 → 标注 tab → 历史 → 展开达标轮次、滚到目标轮并闪一下组头。 */
  function applyAutoHistory(key: string, decision: AutoHistoryDecision): void {
    if (!historyGroups.value.some((group) => group.round === decision.round)) return
    const panel = useBrowserPanelStore()
    const previous: AutoHistoryPrevious = {
      open: panel.open !== false,
      annotationsTab: panel.activeTab === 'annotation',
      mode: panel.mode,
      view: historyViewOpen.value ? 'history' : 'current'
    }
    externalSessions.get(key)?.shown.add(decision.round)
    panel.SET_TAB('annotation')
    autoHistory.value = {
      ...decision,
      key,
      previous,
      restorable: !(previous.open && previous.annotationsTab && previous.view === 'history'),
      seq: ++autoHistorySeq
    }
    requestPanelView({
      view: 'history',
      expandRounds: decision.rounds,
      focusRound: decision.round
    })
  }

  /** 横幅「返回」：把右栏恢复到自动切换之前（开合 / tab / 当前或历史）。 */
  function RESTORE_AUTO_HISTORY(): void {
    const current = autoHistory.value
    if (!current) return
    autoHistory.value = null
    const panel = useBrowserPanelStore()
    const previous = current.previous
    if (previous.view !== 'history') requestPanelView({ view: previous.view })
    if (!previous.annotationsTab) panel.SET_TAB(previous.mode)
    if (!previous.open) panel.SET_OPEN(false)
  }

  /** 横幅 ×：只收起横幅，停在历史。 */
  function DISMISS_AUTO_HISTORY(): void {
    autoHistory.value = null
  }

  /** 横幅「不再自动切换」：写偏好（偏好设置 → 通用 → 内容标注 可以再打开）。 */
  function DISABLE_AUTO_HISTORY(): void {
    autoHistory.value = null
    preferencesStore.SET_SINGLE_PREFERENCE({ type: 'annotationAutoHistory', value: false })
    notice.notify({ message: t('annotation.autoHistory.disabled'), type: 'info', time: 4000 })
  }

  function resetAutoHistory(): void {
    cancelExternalEval()
    if (applyTimer) {
      clearTimeout(applyTimer)
      applyTimer = null
    }
    externalSessions.clear()
    pendingSwitch = null
    autoHistory.value = null
    watchInteraction(false)
  }
  watch(autoHistoryEnabled, (on) => {
    if (!on) resetAutoHistory()
  })
  // 用户自己离开历史视图：横幅的使命结束（「返回」也没有意义了）。
  watch(historyViewOpen, (open) => {
    if (!open) autoHistory.value = null
  })

  /** 切到某篇文档后：它在后台被外部改过就补上评估；有等着切的判定就再试一次。 */
  function resumeExternalFor(key: string | null): void {
    if (!isRealPath(key)) return
    const session = externalSessions.get(key)
    if (
      session &&
      session.lastAt > session.evaluatedAt &&
      Date.now() - session.lastAt <= AUTO_HISTORY_HOLD_MS
    ) {
      scheduleExternalEval(key)
    }
    if (pendingSwitch?.key === key) tryApplyAutoHistory()
  }

  /** 条目在文档里的序号（1 起）：优先引擎给的文档序号，退化为创建顺序。 */
  const orderOf = (id: string): number => {
    const fromEngine = indexById.value[id]
    if (typeof fromEngine === 'number' && fromEngine > 0) return fromEngine
    const byCreated = annotations.value
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .findIndex((a) => a.id === id)
    return byCreated >= 0 ? byCreated + 1 : 0
  }

  const findById = (id: string): IAnnotation | null =>
    annotations.value.find((a) => a.id === id) ?? null

  // ── 引擎挂载 ──────────────────────────────────────────────────────

  /** 挂引擎实例（editor.vue 拿到 muya 后调用）。重复调用按覆盖处理。 */
  function attachEngine(instance: unknown): void {
    engine = instance as { annotation?: unknown; eventCenter?: EngineEventCenter }
    bindEngineEvents(engine.eventCenter ?? null)
    pushToEngine()
  }

  /** 把当前文档的标注表、开关与常用语一次性推给引擎（切换文档 / 挂载时）。 */
  function pushToEngine(): void {
    const module = annotationModule()
    if (!module) return
    module.setEnabled?.(enabled.value)
    module.setAnnotations?.(currentDoc.value?.annotations ?? [])
    // 常用语不随文档变，但引擎是「挂载时才收到整表」：漏掉这一行，编辑器在
    // 偏好 watch（immediate 那次）之后才挂载，chips 永远是空的。
    module.setQuickPhrases?.(quickPhrases())
  }

  // ── 载入 / 落盘 ───────────────────────────────────────────────────

  /**
   * 从引擎回读标注表（`annotation-change` 后调用）。
   *
   * `engineHint` 由**事件的发出方**传入：分屏还回标签栏 / 关分屏时，`RETURN_SPLIT_TO_TABS`
   * 会先把 `docFocused` 置 false，右栏编辑器卸载时便跳过了交还主引擎，store 的
   * `engine` 可能停在一个已销毁的实例上——此时按 store 指针读就是一张空表，面板
   * 永远不更新（还会把空表写盘）。带上发出方就不会读错引擎。
   */
  function syncFromEngine(engineHint?: unknown): void {
    const module = engineHint ? annotationModuleOf(engineHint) : annotationModule()
    const doc = currentDoc.value
    if (!module || !doc) return

    const fromEngine = (module.list?.() as IAnnotation[] | undefined) ?? []
    // 引擎理论上持有整表（含归档），但不做这个假设：归档条目丢了就补回来，
    // 否则历史会随一次同步无声消失。
    const engineIds = new Set(fromEngine.map((a) => a.id))
    const keptArchived = doc.annotations.filter((a) => a.archived && !engineIds.has(a.id))
    doc.annotations = [...fromEngine, ...keptArchived]

    refreshIndexById()
    persist(activeKey.value)
  }

  /**
   * 刷新 id → 文档序号映射（面板序号 / `locate()` 定位都用它）。只在条目集合或
   * 「归档 / 锚点健康度」变化时才问引擎要导出（getExport 会算一遍行号，别每次
   * 同步都跑）。
   *
   * 对齐基准是**过滤掉归档后的那份表**，不是整表：`list()`（= `annotations`）
   * 含归档条目，而 `getExport()` 只给未归档条目编号（正文角标走引擎 `_indexMap()`，
   * 同一口径）。拿整表对齐会「只要归档过一条就长度不符」，映射整表作废、面板退回
   * 创建顺序编号——正文角标 ③ 配面板 ② 就是这么来的。
   *
   * 两表位置一一对应成立的前提：`list()` 与 `getExport()` 都是
   * `orderAnnotationsByDocument()` 的结果，排序键（块序号 / 块内偏移 / 原序）与
   * `archived` 无关，所以从 `list()` 里滤掉归档条目后，剩下的相对顺序与
   * `getExport()` 完全相同。
   */
  let lastIndexSignature = ''
  function refreshIndexById(): void {
    const module = annotationModule()
    if (!module) return
    // 签名里必须带归档标志与 anchorState：正文角标只给未归档条目编号，归档 /
    // 恢复 / 转失效都会让后面条目的序号整体前移，光看 id 列表发现不了。
    const signature = annotations.value
      .map((a) => `${a.id}:${a.archived ? 1 : 0}:${a.anchorState}`)
      .join(',')
    if (signature === lastIndexSignature) return
    lastIndexSignature = signature

    const visible = annotations.value.filter((a) => !a.archived)
    const items = (module.getExport?.() as IAnnotationExportItem[] | undefined) ?? []
    if (items.length !== visible.length) {
      indexById.value = {}
      return
    }
    const next: Record<string, number> = {}
    items.forEach((item, position) => {
      const annotation = visible[position]
      if (!annotation || typeof item?.index !== 'number') return
      next[annotation.id] = item.index
    })
    indexById.value = next
  }

  /** 从盘上读一个路径的标注文件（不存在 / 读失败 → null；`round` 已归一）。 */
  async function readFromDisk(
    pathname: string
  ): Promise<Pick<AnnotationDocCache, 'round' | 'annotations' | 'docHash'> | null> {
    try {
      const document = (await window.electron.ipcRenderer.invoke(
        'mt::annotation::load',
        pathname
      )) as AnnotationDocument | null
      if (!document) return null
      return {
        round: normalizeRound(document.round),
        annotations: document.annotations ?? [],
        docHash: document.docHash
      }
    } catch (error) {
      console.error('[annotation] Failed to load annotations.', error)
      return null
    }
  }

  /** 读一个文档的标注（已读过则跳过）。 */
  async function loadFor(pathname: string): Promise<void> {
    const key = isRealPath(pathname) ? pathname : activeKey.value
    if (!isRealPath(key)) return
    if (docs.value[key]?.loaded) return

    const disk = await readFromDisk(key)
    docs.value[key] = {
      round: disk?.round ?? 1,
      annotations: disk?.annotations ?? [],
      docHash: disk?.docHash,
      loaded: true
    }
    if (key === activeKey.value) pushToEngine()
  }

  const normalizeRound = (round: number | undefined): number =>
    typeof round === 'number' && Number.isFinite(round) && round >= 1 ? round : 1

  /**
   * 并集合并——**只用于路径迁移**（与主进程 `annotationStore.mergeUnion` 同一规则，
   * 两边不能只有一边改）：目标路径已有的标注保留在前面，被移入的条目追加到后面，
   * 同 id 冲突取 `updatedAt` 新的。
   *
   * 不能沿用 `save` 的「传入版本为准」规则：那条规则的前提是「渲染层是这份文档的
   * 唯一写方」，而迁移时两份数据来自**两个不同文件**，谁都不该被对方整份顶掉。
   */
  const unionAnnotations = (source: IAnnotation[], target: IAnnotation[]): IAnnotation[] => {
    const byId = new Map<string, IAnnotation>()
    const order: string[] = []
    const put = (entry: IAnnotation): void => {
      if (!entry || typeof entry.id !== 'string') return
      const existing = byId.get(entry.id)
      if (!existing) {
        byId.set(entry.id, entry)
        order.push(entry.id)
        return
      }
      const previousAt = typeof existing.updatedAt === 'number' ? existing.updatedAt : 0
      const incomingAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
      if (incomingAt > previousAt) byId.set(entry.id, entry)
    }

    for (const entry of target) put(entry)
    for (const entry of source) put(entry)

    return order.map((id) => byId.get(id)!)
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const PERSIST_DEBOUNCE_MS = 800

  /** 变更后 debounce 800ms 写盘（方案 §5.5）。 */
  function persist(pathname: string | null): void {
    const key = pathname ?? activeKey.value
    if (!isRealPath(key) || !docs.value[key]) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      flush(key)
    }, PERSIST_DEBOUNCE_MS)
  }

  /** 立即落盘（tab 关闭 / 切换文件 / 离开标注 tab / 应用退出）。 */
  async function flush(pathname: string | null = null): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    const key = pathname ?? activeKey.value
    if (!isRealPath(key)) return
    const doc = docs.value[key]
    if (!doc) return

    try {
      await window.electron.ipcRenderer.invoke('mt::annotation::save', {
        pathname: key,
        round: doc.round,
        docHash: doc.docHash,
        // Pinia 的 reactive Proxy 过不了 IPC 的结构化克隆（"An object could not
        // be cloned"）——发送前深拷贝成纯 JSON 对象；标注数据本身就是 JSON 结构。
        annotations: JSON.parse(JSON.stringify(doc.annotations))
      })
    } catch (error) {
      console.error('[annotation] Failed to save annotations.', error)
    }
  }

  /**
   * 改名 / 另存为：把标注搬到新路径的 key 下（内存 + 主进程两侧）。
   *
   * 目标路径可能已经有自己的标注（另存为覆盖一个已标注的文件）：主进程侧的迁移是
   * **并集**（目标原有条目保留、源条目追加），所以搬完之后不能沿用源那份内存表——
   * 必须以盘上那份并集为准（`loadFor`），否则下一次 `flush` 会按「传入版本为准」
   * 的保存规则把目标原有的标注从盘上抹掉。
   */
  async function MIGRATE_PATH({ from, to }: { from: string; to: string }): Promise<void> {
    if (!from || !to || from === to) return
    if (!isRealPath(from) || !isRealPath(to)) return

    await flush(from)
    const moved = docs.value[from]
    delete docs.value[from]
    if (activeKey.value === from) activeKey.value = to

    let migrated = false
    try {
      const result = (await window.electron.ipcRenderer.invoke('mt::annotation::migrate-path', {
        from,
        to
      })) as { ok?: boolean } | undefined
      migrated = result?.ok !== false
    } catch (error) {
      console.error('[annotation] Failed to migrate annotation file.', error)
    }

    if (!migrated) {
      // 迁移失败：退回「内存搬家」，先保住这份表（下次 flush 会写进新路径）。
      if (moved) docs.value[to] = moved
      return
    }

    delete docs.value[to]
    await loadFor(to)
  }

  /** 主编辑区换标签：flush 旧文档、装载新文档、把新表推给引擎。 */
  async function SWITCH_DOC({
    pathname,
    tabId
  }: {
    pathname: string
    tabId: string
  }): Promise<void> {
    const key = isRealPath(pathname) ? pathname : `${UNTITLED_PREFIX}${tabId}`
    if (key === activeKey.value) return

    const previous = activeKey.value
    if (previous && isRealPath(previous)) flush(previous)

    activeKey.value = key
    activeId.value = null
    lastIndexSignature = ''

    if (isRealPath(key)) {
      await loadFor(key)
    } else if (!docs.value[key]) {
      // 未保存文档：标注只存内存，保存（tab-saved）后迁到路径 key。
      docs.value[key] = { round: 1, annotations: [], loaded: true }
    }
    pushToEngine()
    // 这篇在后台被外部改过 / 有等着切的判定：切回来时补上。
    resumeExternalFor(key)
  }

  /**
   * 主编辑区切到只读 html 标签：html 没有标注，面板脱离当前文档。旧文档先落盘；
   * 不推引擎——引擎（被隐藏）仍持有上一篇 md，切回去时 SWITCH_DOC 会重新装载。
   */
  function DETACH_DOC(): void {
    const previous = activeKey.value
    if (previous && isRealPath(previous)) flush(previous)
    activeKey.value = null
    activeId.value = null
    lastIndexSignature = ''
  }

  /**
   * 焦点切到某个编辑器：把它挂成当前引擎，并把面板切到它正在编辑的文档。
   *
   * 左右两侧编辑器在**焦点侧真正切换**时各调一次（而不是每次光标移动）——
   * 「谁有光标，标注面板就显示谁的标注」，与顶栏字数/保存状态的焦点路由同源。
   * 右栏分屏文档（docEditorPane）由此与主编辑器平等接入：同一套引擎事件、
   * 同一份按文档存放的标注表。
   */
  async function FOCUS_EDITOR({
    engine: instance,
    pathname,
    tabId
  }: {
    engine: unknown
    pathname: string
    tabId: string
  }): Promise<void> {
    // 先挂引擎再切文档：attachEngine 里的 pushToEngine 会推一次旧表，随后
    // SWITCH_DOC 装载新文档并覆盖——顺序反过来则会用旧引擎推新表。
    attachEngine(instance)
    await SWITCH_DOC({ pathname, tabId })
  }

  /**
   * tab-saved：未保存文档落盘 → 把标注从 `untitled:<tabId>` 迁到路径 key。
   *
   * 目标路径可能**已经有标注文件**（另存为覆盖一个已标注的文件，`save` 的合并规则
   * 是「传入版本为准」——直接写会把对方整份抹掉）：先把盘上那份读回来做并集，再落盘。
   */
  async function ADOPT_PATH({
    tabId,
    pathname
  }: {
    tabId: string
    pathname: string
  }): Promise<void> {
    if (!isRealPath(pathname)) return
    const from = `${UNTITLED_PREFIX}${tabId}`
    const moved = docs.value[from]
    if (!moved) return

    delete docs.value[from]
    if (activeKey.value === from) activeKey.value = pathname

    const disk = await readFromDisk(pathname)
    docs.value[pathname] = {
      // 轮次取两者较大值：两边历史条目共用一套编号，取小会让新轮次与已有历史撞号。
      round: Math.max(moved.round, disk?.round ?? 1),
      annotations: unionAnnotations(moved.annotations, disk?.annotations ?? []),
      docHash: disk?.docHash ?? moved.docHash,
      loaded: true
    }
    await flush(pathname)
    if (activeKey.value === pathname) pushToEngine()
  }

  // ── 标注动作（引擎侧） ────────────────────────────────────────────

  /** 新增一条（快照来自引擎的 `muya-annotation-request`）。 */
  function addAnnotation(snapshot: TSelectionSnapshot, note: string): IAnnotation | null {
    const module = annotationModule()
    if (!module) return null
    const created = module.addFromSnapshot?.(snapshot, note) as IAnnotation | null | undefined
    // 引擎会发 annotation-change → syncFromEngine，这里再兜一次（引擎未实现
    // 同步时至少让面板立即看到后果）。
    if (created) syncFromEngine()
    return created ?? null
  }

  function updateNote(id: string, note: string): void {
    const module = annotationModule()
    if (!module) return
    module.updateNote?.(id, note)
    const target = findById(id)
    if (target) {
      target.note = note
      target.updatedAt = Date.now()
    }
    syncFromEngine()
  }

  /** 面板「＋ 全局备注」：不锚定正文的整篇意见（引擎 addGlobal）。 */
  function addGlobalNote(note: string): boolean {
    const module = annotationModule() as { addGlobal?: (n: string) => unknown } | undefined
    const created = module?.addGlobal?.(note)
    if (!created) {
      return false
    }
    syncFromEngine()
    return true
  }

  function remove(id: string): void {
    annotationModule()?.remove?.(id)
    const doc = currentDoc.value
    if (doc) doc.annotations = doc.annotations.filter((a) => a.id !== id)
    if (activeId.value === id) activeId.value = null
    lastIndexSignature = ''
    refreshIndexById()
    persist(activeKey.value)
  }

  /** ↺ 重新标记为未复制：进入下一批，状态行回到「未复制」。 */
  function reCopy(id: string): void {
    const target = findById(id)
    if (!target) return
    target.copied = false
    target.updatedAt = Date.now()
    // 回退也要重画：正文的「已复制」灰底是从引擎高亮缓存取的 `data-copied`，
    // 不推回去就停在灰色，与面板刚显示的「未复制」长期不一致（理由同 copyAll）。
    pushToEngine()
    persist(activeKey.value)
  }

  /** 归档（单条或多条）：移入历史，正文高亮由引擎随整表刷新消失。 */
  function archive(ids: string[]): void {
    if (!ids.length) return
    const set = new Set(ids)
    let changed = 0
    const archivedAt = Date.now()
    for (const annotation of currentList.value) {
      if (!set.has(annotation.id)) continue
      annotation.archived = true
      annotation.archivedAt = archivedAt
      annotation.updatedAt = archivedAt
      changed += 1
    }
    if (!changed) return
    pushToEngine()
    persist(activeKey.value)
  }

  /** 恢复：回到当前列表，仍为已复制（方案 §2.4）。 */
  function restore(id: string): void {
    const target = findById(id)
    if (!target || !target.archived) return
    target.archived = false
    target.archivedAt = undefined
    target.updatedAt = Date.now()
    pushToEngine()
    persist(activeKey.value)
  }

  /** 从历史里永久删除（单条/整组/清空历史共用）。 */
  function deleteArchived(ids: string[]): void {
    if (!ids.length) return
    const set = new Set(ids)
    const doc = currentDoc.value
    if (!doc) return
    const before = doc.annotations.length
    doc.annotations = doc.annotations.filter((a) => !(a.archived && set.has(a.id)))
    if (doc.annotations.length === before) return
    pushToEngine()
    persist(activeKey.value)
  }

  const archiveCopied = (): void => archive(copiedList.value.map((a) => a.id))
  const archiveOrphan = (): void => archive(orphanList.value.map((a) => a.id))
  const archiveAll = (): void => archive(currentList.value.map((a) => a.id))
  const clearHistory = (): void => deleteArchived(historyList.value.map((a) => a.id))

  // ── 复制 ──────────────────────────────────────────────────────────

  /**
   * 复制所有标注：**只含未复制条目**（方案 §2.4.1）。
   *
   * 链路：未复制 ids → 引擎 `getExport(ids)`（含批量行号）→ `buildCopyText`
   * → 剪贴板；成功后把这一批标为「已复制（第 N 轮）」并记 sentQuote、直接归档
   * 移入历史，轮次 +1。
   *
   * 失效条目不在复制范围（用户拍板）：它已被排除在 `pendingList` 外，想让它
   * 离开当前列表走「归档失效」。
   */
  async function copyAll(): Promise<boolean> {
    const doc = currentDoc.value
    const module = annotationModule()
    if (!doc) return false

    const pending = pendingList.value
    const ids = pending.map((a) => a.id)
    if (!ids.length) return false
    if (!module) {
      notice.notify({ message: t('annotation.toast.engineMissing'), type: 'error', time: 3000 })
      return false
    }

    // 旧版本建的条目没有「标注时」快照：趁复制这一刻补拍（只在原样命中时补，
    // 文字已被改过的留空，历史里按 v2 字段反推）。
    module.ensureOrigins?.(ids)
    const items = (module.getExport?.(ids) as IAnnotationExportItem[] | undefined) ?? []
    // 导出条目数与要复制的 id 数不符 = 引擎表与面板表不同步（典型：切标签后
    // `load` 还没回来就点了复制，引擎表里还是上一个文档的 id）。这时**不能**照样
    // 往下走：剪贴板里会是「共 0 条」的空壳文本，而条目被静默标成「已复制」、
    // 轮次自增——用户以为发出去了，实际什么都没发。
    if (items.length !== ids.length) {
      notice.notify({ message: t('annotation.toast.engineMissing'), type: 'error', time: 3000 })
      return false
    }
    // 未保存文档的 key 是内部标识（`untitled:<tabId>`），不能当路径写进交付文本，
    // 传空串让 `buildCopyText` 出「（未保存文档，尚未落盘）」那一行。
    const text = buildCopyText(items, isRealPath(activeKey.value) ? activeKey.value : '')
    window.electron.clipboard.writeText(text)

    const round = doc.round
    const now = Date.now()
    // 复制文本里的 [n]：历史按它排序、显示，便于对照 agent 的逐条回复。
    const sentIndexById = new Map<string, number>()
    for (const item of items) {
      if (typeof item.id === 'string') sentIndexById.set(item.id, item.index)
    }
    for (const annotation of pending) {
      annotation.copied = true
      annotation.round = round
      annotation.sentQuote = annotation.anchor.quote
      const sentIndex = sentIndexById.get(annotation.id)
      if (typeof sentIndex === 'number') annotation.sentIndex = sentIndex
      annotation.updatedAt = now
      // 用户拍板：复制过的条目直接移入历史（不再留在当前列表等手动归档）。
      annotation.archived = true
      annotation.archivedAt = now
    }
    doc.round = round + 1
    copiedText.value = text
    // 正文高亮的「已复制」态从引擎的高亮缓存里取（`data-copied`），而缓存只在
    // `_invalidate()` + 重画时才重建——所以这里必须把整表推回引擎重画一次，
    // 否则刚复制完的条目在正文里仍是「未复制」配色（面板已说「第 N 轮 · 已复制」，
    // 两处打架，且要等到该块因别的原因重渲染才自愈）。归档 / 恢复 / 删除走的是
    // 同一条路（`pushToEngine()`）。
    pushToEngine()
    persist(activeKey.value)
    return true
  }

  /** 上一轮已复制且仍留在当前列表的条目 —— 「可以归档了」提示的判定依据。 */
  const archivableAfterCopy = computed(() => {
    const latest = copiedList.value.reduce(
      (max, a) => Math.max(max, typeof a.round === 'number' ? a.round : 0),
      0
    )
    if (!latest) return []
    // 提示的是「上一轮」：最近一轮之前所有仍在本列表的已复制条目。
    return copiedList.value.filter((a) => (typeof a.round === 'number' ? a.round : 0) < latest)
  })

  // ── 定位 ──────────────────────────────────────────────────────────

  /**
   * 定位到正文：滚动到该条高亮处并脉冲 1.2s，**不移动光标**（方案 §3.4）。
   *
   * 序号走 `indexById`（由全量 `getExport()` 建立、与引擎给正文角标编号的
   * `_indexMap()` 同源），再去 DOM 里找 `<span class="mu-annotation" data-index="n">`
   * （方案 §5.3 的冻结契约：annotation 高亮输出 data-index）。序号错了会滚到别的
   * 标注上，比不定位更糟。
   *
   * **不能**用单条 `getExport([id]).index` 取序号：那个 `index` 是「返回数组内」
   * 的 1-based 序号（引擎 `getExport` 的既定语义，`anchor.spec.ts` 有断言），只传
   * 一个 id 时恒等于 1——每次定位都会跳到文档顺序第 1 条标注上，并给它的高亮加
   * 脉冲，而面板把**目标**卡片标成 active（面板与正文各指一条）。
   */
  function locate(id: string): void {
    const target = findById(id)
    if (!target) return
    if (target.archived) {
      // 历史条目没有正文高亮 span（不进序号表）：交给引擎按「现在」的位置定位。
      revealHistory(id)
      return
    }
    // 全局备注没有正文位置，点击不做定位。
    if (target.global) return
    if (isOrphan(target)) {
      notice.notify({ message: t('annotation.toast.orphan'), type: 'info', time: 2500 })
      return
    }

    const module = annotationModule()
    const order = indexById.value[id]
    const spans =
      typeof order === 'number' && order > 0
        ? document.querySelectorAll(`.mu-annotation[data-index="${order}"]`)
        : null

    if (!spans || !spans.length) {
      // 序号拿不到（引擎未挂载 / 表还没同步）或该块一期不画高亮（代码块、数学块…）。
      const native = module?.locate?.(id)
      if (!native) {
        notice.notify({ message: t('annotation.toast.orphan'), type: 'info', time: 2500 })
        return
      }
    }

    activeId.value = id
    const first = spans?.[0] as HTMLElement | undefined
    if (first) {
      first.scrollIntoView({ block: 'center', behavior: 'smooth' })
      spans?.forEach((span) => span.classList.add('mu-annotation-active'))
      window.setTimeout(() => {
        spans?.forEach((span) => span.classList.remove('mu-annotation-active'))
        if (activeId.value === id) activeId.value = null
      }, 2200)
    }
  }

  /** 飞点到达徽标时调用：bpModes 监听 badgePulse 后播 1→1.22→1 弹跳。 */
  function PULSE_BADGE(): void {
    badgePulse.value += 1
  }

  // ── 面板开合联动 ──────────────────────────────────────────────────

  /** 工具条「标注」按钮 → 展开右栏并切到标注 tab（方案 §3.1）。 */
  function REVEAL(): void {
    useBrowserPanelStore().SET_TAB('annotation')
  }

  // 离开标注 tab 立即 flush（方案 §5.5）。只在「确实是从标注 tab 切走」时写盘
  // ——url/doc 之间来回切不该带来多余 IO。
  let wasAnnotationTab = false
  watch(
    () => useBrowserPanelStore().activeTab,
    (tab) => {
      const isAnnotationTab = tab === 'annotation'
      if (wasAnnotationTab && !isAnnotationTab && isRealPath(activeKey.value)) {
        flush(activeKey.value)
      }
      wasAnnotationTab = isAnnotationTab
    }
  )

  // 标注表整体换过（回读引擎 / 外部重载 / 切文档 / 归档恢复）→ 历史的「现在」重算。
  // syncFromEngine 每次都换新数组，所以浅 watch 足够；切文档先清空，避免短暂
  // 显示上一篇文档的检视结果。
  watch(activeKey, (key) => {
    historyNow.value = {}
    historyFocusId.value = null
    annotationModule()?.clearReveal?.()
    // 外部修改的评估只针对当时的文档：换文档即作废在途的（切回来由 resumeExternalFor 补上）。
    cancelExternalEval()
    if (autoHistory.value && autoHistory.value.key !== key) autoHistory.value = null
  })
  watch(annotations, () => scheduleHistoryRefresh())

  // 偏好开关变化即时同步给引擎（关 = 不画高亮；数据保留）。
  watch(enabled, (value) => {
    annotationModule()?.setEnabled?.(value)
  })

  // 常用语变化（改一条也算）整表推给引擎：设置弹窗里增删改 / 排序后卡片 chips
  // 实时刷新，无需重开卡片（方案 §2.1）。deep 才能感知数组元素级变更。
  watch(
    () => preferencesStore.annotationQuickPhrases,
    () => {
      annotationModule()?.setQuickPhrases?.(quickPhrases())
    },
    { deep: true, immediate: true }
  )

  // 应用退出：把当前快照投给主进程（不等返回）。常规 debounce 写盘兜底。
  //
  // 方案 §5.5 原写「用 send 不等返回」；契约冻结的通道只有 load / save /
  // migrate-path 三个 invoke，没有 send 变体，所以这里复用 `save`——invoke
  // 在调用瞬间就把消息排进主进程队列（不依赖回包），主进程侧
  // `writeFileAtomic.sync` 是同步写，效果等价，掉回包不影响落盘。
  function installUnloadFlush(): () => void {
    const handler = (): void => {
      flush(activeKey.value)
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }

  return {
    // state
    docs,
    activeKey,
    activeId,
    copiedText,
    // getters
    enabled,
    currentDoc,
    annotations,
    currentList,
    historyList,
    pendingList,
    copiedList,
    orphanList,
    counts,
    uncopiedCount,
    isUntitled,
    historyGroups,
    historyCompareGroups,
    historyNow,
    archivableAfterCopy,
    // engine
    attachEngine,
    syncFromEngine,
    pushToEngine,
    // 载入 / 落盘
    loadFor,
    persist,
    flush,
    addGlobalNote,
    MIGRATE_PATH,
    SWITCH_DOC,
    DETACH_DOC,
    FOCUS_EDITOR,
    ADOPT_PATH,
    // 动作
    addAnnotation,
    updateNote,
    remove,
    reCopy,
    archive,
    archiveCopied,
    archiveOrphan,
    archiveAll,
    restore,
    deleteArchived,
    clearHistory,
    // 复制 / 定位 / 交互
    copyAll,
    locate,
    REVEAL,
    orderOf,
    findById,
    installUnloadFlush,
    // 历史对比
    refreshHistoryNow,
    historyVisible,
    historyFocusId,
    revealHistory,
    SET_HISTORY_VIEW,
    SET_HISTORY_OPEN_ROUNDS,
    // 外部批量改动后自动切到历史（第三轮）
    autoHistoryEnabled,
    autoHistory,
    panelViewRequest,
    NOTE_EXTERNAL_RELOAD,
    RESTORE_AUTO_HISTORY,
    DISMISS_AUTO_HISTORY,
    DISABLE_AUTO_HISTORY,
    // 常用语（feat/quick-phrases）：设置弹窗开关 / 保存信号 / 徽标弹跳脉冲
    quickPhraseSettingsOpen,
    savedPulse,
    badgePulse,
    PULSE_BADGE,
    // 纯函数（单测直接 import 模块级导出即可，这里一并挂上便于组件统一取用）
    buildCopyText
  }
})
