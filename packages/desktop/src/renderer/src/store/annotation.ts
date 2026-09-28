import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import notice from '../services/notification'
import { t } from '../i18n'
import type { AnnotationDocument, IAnnotation, IAnnotationExportItem } from '@shared/types/ipc'
import { useBrowserPanelStore } from './browserPanel'
import { usePreferencesStore } from './preferences'

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
  let engine: { annotation?: unknown } | null = null

  const annotationModule = (): Record<string, (...args: unknown[]) => unknown> | null => {
    const module = engine?.annotation as Record<string, (...args: unknown[]) => unknown> | undefined
    return module ?? null
  }

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
    engine = instance as { annotation?: unknown }
    pushToEngine()
  }

  function detachEngine(): void {
    engine = null
  }

  /** 把当前文档的标注表与开关一次性推给引擎（切换文档 / 挂载时）。 */
  function pushToEngine(): void {
    const module = annotationModule()
    if (!module) return
    module.setEnabled?.(enabled.value)
    module.setAnnotations?.(currentDoc.value?.annotations ?? [])
  }

  // ── 载入 / 落盘 ───────────────────────────────────────────────────

  /** 从引擎回读标注表（`annotation-change` 后调用）。 */
  function syncFromEngine(): void {
    const module = annotationModule()
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
    for (const annotation of pending) {
      annotation.copied = true
      annotation.round = round
      annotation.sentQuote = annotation.anchor.quote
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
      notice.notify({ message: t('annotation.toast.archived'), type: 'info', time: 2500 })
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

  // 偏好开关变化即时同步给引擎（关 = 不画高亮；数据保留）。
  watch(enabled, (value) => {
    annotationModule()?.setEnabled?.(value)
  })

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
    archivableAfterCopy,
    // engine
    attachEngine,
    detachEngine,
    syncFromEngine,
    pushToEngine,
    // 载入 / 落盘
    loadFor,
    persist,
    flush,
    addGlobalNote,
    MIGRATE_PATH,
    SWITCH_DOC,
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
    // 纯函数（单测直接 import 模块级导出即可，这里一并挂上便于组件统一取用）
    buildCopyText
  }
})
