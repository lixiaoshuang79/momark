<template>
  <div class="ann-panel">
    <div class="ann-head">
      <div class="seg2" role="tablist" aria-label="标注视图">
        <span class="seg2-slider" :class="{ right: view === 'history' }" aria-hidden="true" />
        <button
          role="tab"
          data-view="current"
          :aria-selected="view === 'current'"
          @click="setView('current')"
        >
          {{ t('annotation.current') }}
        </button>
        <button
          role="tab"
          data-view="history"
          :aria-selected="view === 'history'"
          @click="setView('history')"
        >
          {{ t('annotation.history') }}
        </button>
      </div>
      <div class="counts">
        {{ t('annotation.count.uncopied') }} <b>{{ counts.pending }}</b> ·
        {{ t('annotation.count.copied') }} <b>{{ counts.copied }}</b> ·
        {{ t('annotation.count.orphan') }} <b>{{ counts.orphan }}</b>
      </div>
    </div>

    <!-- 未保存文档：标注只存内存（方案 §3.6），保存后随文件落盘 -->
    <div v-if="store.isUntitled" class="ann-note">
      {{ t('annotation.untitledNote') }}
    </div>

    <!-- 复制后的归档提示：只提示不代做（方案 §2.4.3） -->
    <div v-if="view === 'current' && archiveHintOpen" class="ann-hint-bar">
      <span>{{ t('annotation.archiveHint', { n: store.archivableAfterCopy.length }) }}</span>
      <button class="mini" @click="doArchiveHint">
        {{ t('annotation.archiveHintAction') }}
      </button>
      <button
        class="hint-close"
        :title="t('annotation.action.close')"
        @click="archiveHintOpen = false"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>

    <!-- 外部批量修改后自动切到历史（第三轮）：说明为什么切过来、可一键返回 -->
    <div v-if="view === 'history' && autoBanner" class="ann-hint-bar auto-hist" role="status">
      <div class="ah-body">
        <span class="ah-text">{{
          t('annotation.autoHistory.banner', { round: autoBanner.round, n: autoBannerCount })
        }}</span>
        <span class="ah-row">
          <span
            v-for="part in summaryParts(autoBannerSummary)"
            :key="part.status"
            class="hg-chip"
            :class="part.status"
            ><i class="dot" />{{ part.text }}</span
          >
          <span class="ah-actions">
            <button
              v-if="autoBanner.restorable"
              class="mini"
              :title="t('annotation.autoHistory.restoreTitle')"
              @click="store.RESTORE_AUTO_HISTORY()"
            >
              {{ t('annotation.autoHistory.restore') }}
            </button>
            <button class="ah-link" @click="store.DISABLE_AUTO_HISTORY()">
              {{ t('annotation.autoHistory.disable') }}
            </button>
          </span>
        </span>
      </div>
      <button
        class="hint-close"
        :title="t('annotation.action.close')"
        @click="store.DISMISS_AUTO_HISTORY()"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>

    <!-- ── 当前视图 ── -->
    <div v-if="view === 'current'" class="ann-list">
      <div v-if="!currentList.length && !orphanList.length" class="empty">
        {{ t('annotation.empty.current') }}<br />{{ t('annotation.empty.currentSub') }}
      </div>
      <template v-else>
        <annotation-card
          v-for="item in healthyList"
          :key="item.id"
          :annotation="item"
          :order="store.orderOf(item.id)"
          :entering="!!enteringIds[item.id]"
        />
        <template v-if="orphanList.length">
          <div
            class="group-head"
            :class="{ open: orphanOpen }"
            role="button"
            tabindex="0"
            @click="orphanOpen = !orphanOpen"
            @keydown.enter.prevent="orphanOpen = !orphanOpen"
          >
            <svg
              class="chev"
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            <span>{{ t('annotation.orphanGroup', { n: orphanList.length }) }}</span>
            <span class="n">{{ t('annotation.orphanGroupNote') }}</span>
          </div>
          <template v-if="orphanOpen">
            <annotation-card
              v-for="item in orphanList"
              :key="item.id"
              :annotation="item"
              :order="store.orderOf(item.id)"
            />
          </template>
        </template>
      </template>
    </div>

    <!-- ── 历史视图：每条「标注时 ↔ 现在」对照（feat/annotation-history-compare）── -->
    <div v-else ref="histListRef" class="ann-list hist-list">
      <div v-if="!store.historyCompareGroups.length" class="empty">
        {{ t('annotation.empty.history') }}<br />{{ t('annotation.empty.historySub') }}
      </div>
      <template v-else>
        <div class="hist-tools">
          <button
            class="hist-filter"
            :class="{ on: onlyChanged }"
            :aria-pressed="onlyChanged"
            @click="onlyChanged = !onlyChanged"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5z" />
            </svg>
            {{ t('annotation.compare.onlyChanged') }}
          </button>
        </div>
        <section
          v-for="group in store.historyCompareGroups"
          :key="group.round"
          class="hist-group"
          :data-round="group.round"
        >
          <button
            class="hg-head"
            :class="{ open: isHistoryOpen(group.round), 'auto-hit': flashRound === group.round }"
            :aria-expanded="isHistoryOpen(group.round)"
            @click="toggleHistory(group.round)"
          >
            <svg
              class="chev"
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            <span class="rname">{{ roundLabel(group.round) }}</span>
            <span
              >· {{ formatTime(group.at) }} ·
              {{ t('annotation.historyCount', { n: group.items.length }) }}</span
            >
            <span class="del" @click.stop="deleteRound(roundRef(group))">{{
              t('annotation.deleteRound')
            }}</span>
          </button>
          <div v-if="summaryParts(group.summary).length" class="hg-summary">
            <span
              v-for="part in summaryParts(group.summary)"
              :key="part.status"
              class="hg-chip"
              :class="part.status"
              ><i class="dot" />{{ part.text }}</span
            >
          </div>
          <template v-if="isHistoryOpen(group.round)">
            <annotation-history-item
              v-for="entry in visibleItems(group.items)"
              :key="entry.annotation.id"
              :item="entry"
            />
            <div v-if="!visibleItems(group.items).length" class="hist-none">
              {{ t('annotation.compare.noneChanged') }}
            </div>
          </template>
        </section>
        <div class="retention">
          {{ t('annotation.retention') }}
        </div>
      </template>
    </div>

    <!-- 全局备注输入区：就地展开在底条上方（不弹文档内卡片） -->
    <div v-if="composerOpen" class="ann-composer">
      <textarea
        ref="composerRef"
        v-model="composerNote"
        class="ann-composer-note"
        :placeholder="t('annotation.globalNotePlaceholder')"
        @keydown="onComposerKeydown"
      />
      <div class="ann-composer-foot">
        <button class="mini" @click="closeComposer">
          {{ t('annotation.action.cancel') }}
        </button>
        <button class="btn-primary mini" :disabled="!composerNote.trim()" @click="saveGlobalNote">
          {{ t('annotation.action.save') }}
        </button>
      </div>
    </div>

    <!-- ── 底条（面板自带；url/doc 的底条由 index.vue 按 tab 分配）── -->
    <div class="ann-foot">
      <template v-if="view === 'current'">
        <button
          class="btn-ghost"
          :title="t('annotation.action.newAnnotationTitle')"
          @click.stop="openComposer()"
        >
          ＋ {{ t('annotation.action.newAnnotation') }}
        </button>
        <button
          class="btn-primary"
          :disabled="!counts.pending"
          :title="copyButtonTitle"
          @click="copyAll"
        >
          {{
            copyDone ? t('annotation.copiedDone') : t('annotation.copyAll', { n: counts.pending })
          }}
        </button>
        <div class="menu-wrap">
          <button
            class="icon-btn"
            :title="t('annotation.moreMenu')"
            @click.stop="archiveMenuOpen = !archiveMenuOpen"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="3" cy="8" r="1.4" />
              <circle cx="8" cy="8" r="1.4" />
              <circle cx="13" cy="8" r="1.4" />
            </svg>
          </button>
          <div v-if="archiveMenuOpen" class="menu">
            <button v-if="store.copiedText" @click="openDrawerFromMenu">
              {{ t('annotation.copiedText') }}
            </button>
            <div v-if="store.copiedText" class="menu-sep" />
            <button :disabled="!store.copiedList.length" @click="runArchive('copied')">
              {{ t('annotation.archiveCopied', { n: store.copiedList.length }) }}
            </button>
            <button :disabled="!store.orphanList.length" @click="runArchive('orphan')">
              {{ t('annotation.archiveOrphan', { n: store.orphanList.length }) }}
            </button>
            <button :disabled="!store.currentList.length" @click="runArchive('all')">
              {{ t('annotation.archiveAll') }}
            </button>
          </div>
        </div>
      </template>
      <template v-else>
        <button class="btn-ghost wide" :disabled="!store.historyList.length" @click="clearHistory">
          {{ t('annotation.clearHistory') }}
        </button>
      </template>
    </div>

    <!-- 「已复制文本」查看抽屉：最近一次投给剪贴板的全文 -->
    <teleport to="body">
      <div v-if="drawerOpen" class="ann-sheet-mask" @click.self="drawerOpen = false">
        <div class="ann-sheet" role="dialog" aria-modal="true">
          <header>
            {{ t('annotation.copiedTextTitle') }}
            <span class="s-sub">{{ t('annotation.copiedTextLines', { n: copiedLineCount }) }}</span>
            <button
              class="icon-btn"
              :title="t('annotation.action.close')"
              @click="drawerOpen = false"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </header>
          <pre>{{ store.copiedText }}</pre>
          <footer>
            <button class="mini" @click="drawerOpen = false">
              {{ t('annotation.action.close') }}
            </button>
          </footer>
        </div>
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import notice from '@/services/notification'
import { t } from '../../i18n'
import AnnotationCard from './annotationCard.vue'
import AnnotationHistoryItem from './annotationHistoryItem.vue'
import {
  prefersReducedMotion,
  useAnnotationStore,
  type HistoryCompareItem,
  type THistoryStatus
} from '@/store/annotation'
import { useBrowserPanelStore } from '@/store/browserPanel'

/**
 * 右栏第三 tab：标注面板（方案 §3.4 / 原型 .pane[data-pane=ann]）。
 *
 * 顶部「当前 / 历史」segmented + 计数行，中部列表（失效条目折叠分组），
 * 底部操作条（复制所有标注 / 已复制文本抽屉 / 归档 ▾）。历史视图按轮次
 * 分组、带恢复 / 删除 / 整组删除 / 清空历史。底条由本组件自带——面板容器
 * 按 tab 只挂一个底条，切 tab 不出现两条。
 */

const store = useAnnotationStore()

type AnnView = 'current' | 'history'
const view = ref<AnnView>('current')
const orphanOpen = ref(false)
const drawerOpen = ref(false)
const archiveMenuOpen = ref(false)
const archiveHintOpen = ref(false)
const copyDone = ref(false)
const openRounds = ref<Record<number, boolean>>({})
let copyDoneTimer: ReturnType<typeof setTimeout> | null = null

const counts = computed(() => store.counts)
const currentList = computed(() => store.currentList)
const orphanList = computed(() => store.orphanList)
/** 当前列表里未失效的条目（失效的收进折叠分组）。 */
const healthyList = computed(() => currentList.value.filter((a) => a.anchorState !== 'orphaned'))
const copiedLineCount = computed(() => store.copiedText.split('\n').length)

// ── 新条目入场（原型动效 #24，feat/quick-phrases）──────────────────────
// 卡片保存成功时，若面板正停在标注 tab（飞点那一路互斥跳过），新出现的条目做
// opacity+translate 入场 + 底色 accent 8%→0。判定不挂「保存事件」的订阅，而是
// 在列表变化时回看 savedPulse 的时间窗——事件与列表同步的先后顺序不定。
const bpStore = useBrowserPanelStore()
const enteringIds = ref<Record<string, boolean>>({})
let lastHealthyIds: string[] = []

watch(
  () => healthyList.value.map((a) => a.id),
  (ids) => {
    const fresh = ids.filter((id) => !lastHealthyIds.includes(id))
    const gone = lastHealthyIds.some((id) => !ids.includes(id))
    lastHealthyIds = ids
    if (!fresh.length || gone) return
    const pulseAt = store.savedPulse?.at ?? 0
    if (Date.now() - pulseAt > 1500) return
    if (!bpStore.open || bpStore.activeTab !== 'annotation') return
    // 一次冒出一大批（装载文档 / 换文档）不播：只有「刚保存的寥寥几条」才入场
    if (fresh.length > 2) return
    for (const id of fresh) enteringIds.value[id] = true
    window.setTimeout(() => {
      for (const id of fresh) delete enteringIds.value[id]
    }, 1300)
  },
  { immediate: true }
)

const copyButtonTitle = computed(() => {
  if (!store.copiedList.length) return undefined
  return t('annotation.copyAllHint', { n: counts.value.pending })
})

const formatTime = (at: number): string => {
  if (!at) return ''
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const roundLabel = (round: number): string =>
  round > 0 ? t('annotation.historyRound', { round }) : t('annotation.historyUntitledRound')

const setView = (next: AnnView): void => {
  view.value = next
  archiveMenuOpen.value = false
}

/**
 * 默认只展开最新一轮：每条历史现在带两块渲染出来的对照，20 轮全开会很长，
 * 也会一次渲染上百个片段。用户展开 / 收起过的轮次按用户的来。
 */
const latestRound = computed(() => store.historyCompareGroups[0]?.round ?? null)
const isHistoryOpen = (round: number): boolean =>
  openRounds.value[round] ?? round === latestRound.value
const toggleHistory = (round: number): void => {
  openRounds.value = { ...openRounds.value, [round]: !isHistoryOpen(round) }
}

// ── 历史对比：只看有变化 / 每轮摘要 ──────────────────────────────────
const onlyChanged = ref(false)
/** 「只看有变化」隐藏的是「未改动」——删除、改写、待比对都要留着。 */
const visibleItems = (items: HistoryCompareItem[]): HistoryCompareItem[] =>
  onlyChanged.value ? items.filter((item) => item.status !== 'unchanged') : items

const SUMMARY_ORDER: Array<
  Extract<THistoryStatus, 'changed' | 'rewritten' | 'unchanged' | 'deleted'>
> = ['changed', 'rewritten', 'unchanged', 'deleted']
const summaryParts = (
  summary: Record<THistoryStatus, number>
): Array<{ status: string; text: string }> =>
  SUMMARY_ORDER.filter((status) => summary[status] > 0).map((status) => ({
    status,
    text: t(`annotation.compare.summary.${status}`, { n: summary[status] })
  }))

// 告诉 store 面板停在哪个子视图；真正是否检视还要看右栏是否展开、tab 是否是
// 标注（store.historyVisible）——本组件 v-show 常驻，切走 / 收起都不会卸载。
watch(
  view,
  (next) => {
    store.SET_HISTORY_VIEW(next === 'history')
  },
  { immediate: true }
)

// 展开着的轮次交给 store：检视时先做用户正看着的那几轮。
watch(
  () => store.historyCompareGroups.map((group) => group.round).filter(isHistoryOpen),
  (rounds) => store.SET_HISTORY_OPEN_ROUNDS(rounds),
  { immediate: true }
)

// ── 外部批量修改后自动切到历史（第三轮）──────────────────────────────
// store 发请求（panelViewRequest），这里落到组件本地状态：切子视图、展开达标的
// 轮次、把目标轮滚到列表顶部并闪一下组头。展开是「加」不是「换」：用户已展开的
// 轮次保持展开。
const histListRef = ref<HTMLElement | null>(null)
const flashRound = ref<number | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | null = null
const AUTO_FLASH_MS = 3600

watch(
  () => store.panelViewRequest?.seq,
  async () => {
    const request = store.panelViewRequest
    if (!request) return
    setView(request.view)
    if (request.expandRounds?.length) {
      const next = { ...openRounds.value }
      for (const round of request.expandRounds) next[round] = true
      openRounds.value = next
    }
    const round = request.focusRound
    if (typeof round !== 'number') return
    await nextTick()
    const list = histListRef.value
    const section = list?.querySelector<HTMLElement>(`[data-round="${round}"]`)
    if (list && section) {
      const top =
        list.scrollTop + section.getBoundingClientRect().top - list.getBoundingClientRect().top
      list.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    }
    flashRound.value = round
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashTimer = null
      flashRound.value = null
    }, AUTO_FLASH_MS)
  }
)

/** 横幅只属于它那篇文档（切到别的文档就不显示）。 */
const autoBanner = computed(() =>
  store.autoHistory && store.autoHistory.key === store.activeKey ? store.autoHistory : null
)
const autoBannerCount = computed(() => autoBanner.value?.affectedIds.length ?? 0)
const autoBannerSummary = computed<Record<THistoryStatus, number>>(() => ({
  changed: autoBanner.value?.counts.changed ?? 0,
  rewritten: autoBanner.value?.counts.rewritten ?? 0,
  deleted: autoBanner.value?.counts.deleted ?? 0,
  unchanged: 0,
  pending: 0,
  global: 0
}))

// 换文档：上一篇的展开 / 收起不带过来（否则新文档最新一轮可能默认折叠）。
watch(
  () => store.activeKey,
  () => {
    openRounds.value = {}
  }
)

/**
 * 归档 / 清空这类不可撤销的动作走一次确认（方案 §3.4）。
 *
 * `confirmText` 是**必填**：确认 toast 的默认按钮文案是「了解详情」（引导类
 * 通知用的），套在删数据的动作上会变成「点『了解详情』= 真的删掉」——按钮必须
 * 自己写清动作（报告-R2 · A1）。取消路径 = 卡片右上角的 X（title 为「取消」）。
 */
const confirmDialog = async (
  title: string,
  message: string,
  confirmText: string
): Promise<boolean> => {
  try {
    await notice.notify({
      title,
      message,
      type: 'warning',
      time: 0,
      showConfirm: true,
      confirmText
    })
    return true
  } catch {
    return false
  }
}

/** 整组删除只需要轮次与条目 id（对比视图的条目包了一层）。 */
const roundRef = (group: {
  round: number
  items: HistoryCompareItem[]
}): { round: number; items: { id: string }[] } => ({
  round: group.round,
  items: group.items.map((entry) => ({ id: entry.annotation.id }))
})

const deleteRound = async (group: { round: number; items: { id: string }[] }): Promise<void> => {
  const ok = await confirmDialog(
    t('annotation.confirm.deleteRoundTitle'),
    t('annotation.confirm.deleteRound', { round: group.round, n: group.items.length }),
    t('annotation.action.delete')
  )
  if (!ok) return
  store.deleteArchived(group.items.map((item) => item.id))
  notice.notify({
    message: t('annotation.toast.deleteRound', { round: group.round, n: group.items.length }),
    type: 'info',
    time: 2500
  })
}

const clearHistory = async (): Promise<void> => {
  const total = store.historyList.length
  if (!total) return
  const ok = await confirmDialog(
    t('annotation.confirm.clearHistoryTitle'),
    t('annotation.confirm.clearHistory', { n: total }),
    t('annotation.action.clear')
  )
  if (!ok) return
  store.clearHistory()
  notice.notify({
    message: t('annotation.toast.clearHistory', { n: total }),
    type: 'info',
    time: 2500
  })
}

const closeArchiveMenu = (): void => {
  archiveMenuOpen.value = false
}

const runArchive = (kind: 'copied' | 'orphan' | 'all'): void => {
  closeArchiveMenu()
  const before =
    kind === 'copied'
      ? store.copiedList.length
      : kind === 'orphan'
        ? store.orphanList.length
        : store.currentList.length
  if (!before) return
  if (kind === 'copied') store.archiveCopied()
  else if (kind === 'orphan') store.archiveOrphan()
  else store.archiveAll()
  notice.notify({
    message: t('annotation.toast.archiveCount', { n: before }),
    type: 'info',
    time: 2500
  })
}

const doArchiveHint = (): void => {
  const list = store.archivableAfterCopy
  archiveHintOpen.value = false
  if (!list.length) return
  store.archive(list.map((a) => a.id))
  notice.notify({
    message: t('annotation.toast.archiveCount', { n: list.length }),
    type: 'info',
    time: 2500
  })
}

/** 菜单内打开「已复制文本」抽屉：先收起菜单再开（避免两层浮层叠加）。 */
const openDrawerFromMenu = (): void => {
  archiveMenuOpen.value = false
  openDrawer()
}

const openDrawer = (): void => {
  drawerOpen.value = true
}

// ── 全局备注输入区：就地展开在底条上方（不弹文档内卡片）。 ──
const composerOpen = ref(false)
const composerNote = ref('')
const composerRef = ref<HTMLTextAreaElement | null>(null)

const openComposer = (): void => {
  composerOpen.value = true
  nextTick(() => composerRef.value?.focus())
}

const closeComposer = (): void => {
  composerOpen.value = false
  composerNote.value = ''
}

const saveGlobalNote = (): void => {
  if (!composerNote.value.trim()) {
    return
  }
  if (store.addGlobalNote(composerNote.value)) {
    closeComposer()
  }
}

const onComposerKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeComposer()
    return
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    saveGlobalNote()
  }
}

const copyAll = async (): Promise<void> => {
  const copied = await store.copyAll()
  if (!copied) return
  notice.notify({ message: t('annotation.toast.copied'), type: 'info', time: 2000 })
  copyDone.value = true
  if (copyDoneTimer) clearTimeout(copyDoneTimer)
  copyDoneTimer = setTimeout(() => {
    copyDone.value = false
  }, 1500)
  // 每次复制后都重新给一次归档提示（多轮连续复制时重复出现，是方案认可的）。
  if (store.archivableAfterCopy.length) archiveHintOpen.value = true
}

// 点击别处收起「归档 ▾」菜单（菜单是面板内的浮层，不做全局独占）。
const onDocumentClick = (): void => closeArchiveMenu()

let stopUnloadFlush: (() => void) | null = null

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  stopUnloadFlush = store.installUnloadFlush()
})

onBeforeUnmount(() => {
  store.SET_HISTORY_VIEW(false)
  document.removeEventListener('click', onDocumentClick)
  stopUnloadFlush?.()
  stopUnloadFlush = null
  if (copyDoneTimer) clearTimeout(copyDoneTimer)
  if (flashTimer) clearTimeout(flashTimer)
})
</script>

<style scoped>
.ann-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: transparent;
}
/* 「当前 / 历史」二级 tab（feat/right-panel-redesign）：文字 + 2px 下划线表示
   选中，与一级的分段控件区分层级；右侧是计数。 */
.ann-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
  height: 36px;
  padding: 0 12px;
  box-sizing: border-box;
  border-bottom: 0.5px solid var(--line);
}
.seg2 {
  position: relative;
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  flex: none;
  height: 36px;
  margin: 0;
  padding: 0;
  background: none;
}
.seg2-slider {
  position: absolute;
  left: 0;
  bottom: -0.5px;
  width: 50%;
  height: 2px;
  border-radius: 2px;
  background: var(--ink);
  transition: transform 0.26s cubic-bezier(0.2, 0, 0, 1);
  z-index: 0;
}
.seg2-slider.right {
  transform: translateX(100%);
}
.seg2 button {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  padding: 0 8px;
  border: none;
  background: transparent;
  font-size: 12.5px;
  font-family: inherit;
  color: var(--muted);
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.14s ease;
}
.seg2 button:hover {
  color: var(--ink);
}
.seg2 button:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: 6px;
}
.seg2 button[aria-selected='true'] {
  color: var(--ink);
  font-weight: 560;
}
@media (prefers-reduced-motion: reduce) {
  .seg2-slider {
    transition: none;
  }
}
.counts {
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--faint);
}
.counts b {
  font-weight: 500;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.ann-note {
  flex: none;
  padding: 7px 12px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--faint);
  background: var(--hover);
  border-bottom: 1px solid var(--line);
}
.ann-hint-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px 7px 12px;
  font-size: 11.5px;
  color: var(--muted);
  background: color-mix(in oklab, var(--accent) 8%, transparent);
  border-bottom: 1px solid var(--line);
}
.ann-hint-bar > span {
  flex: 1 1 auto;
  min-width: 0;
}
.ann-hint-bar .hint-close {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  border-radius: 4px;
}
.ann-hint-bar .hint-close:hover {
  background: var(--hover);
  color: var(--ink);
}
/* 自动切到历史的说明条：两行（说明 / 计数 + 操作），窄栏下自动换行。 */
.ann-hint-bar.auto-hist {
  align-items: flex-start;
  background: color-mix(in oklab, var(--warn) 10%, transparent);
}
.auto-hist .ah-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.auto-hist .ah-text {
  color: var(--ink);
  line-height: 1.5;
}
.auto-hist .ah-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 11px;
}
.auto-hist .ah-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.auto-hist .ah-link {
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 11px;
  color: var(--faint);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.auto-hist .ah-link:hover {
  color: var(--ink);
}
.ann-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
}
/* 历史条目的「标注时 / 现在」在宽栏下并排：按列表宽度（而不是窗口宽度）判断。 */
.hist-list {
  container: ann-list / inline-size;
}
.hist-tools {
  display: flex;
  justify-content: flex-end;
  padding: 4px 10px 6px;
  border-bottom: 1px solid var(--line);
}
.hist-filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 21px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  font-size: 11.5px;
  font-family: inherit;
  color: var(--muted);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  cursor: pointer;
}
.hist-filter:hover {
  background: var(--hover);
  color: var(--ink);
}
.hist-filter.on {
  color: var(--accent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 55%, transparent);
  background: color-mix(in oklab, var(--accent) 8%, transparent);
}
.hg-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 0 12px 8px 28px;
  margin-top: -4px;
  font-size: 11px;
  color: var(--muted);
}
.hg-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}
.hg-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--faint);
}
.hg-chip.changed .dot,
.hg-chip.rewritten .dot {
  background: var(--success);
}
.hg-chip.unchanged .dot {
  background: var(--warn);
}
.hg-chip.deleted .dot {
  background: var(--danger);
}
.hist-none {
  padding: 8px 12px 12px 26px;
  font-size: 11.5px;
  color: var(--faint);
}
.empty {
  padding: 38px 28px;
  text-align: center;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.8;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  box-sizing: border-box;
  cursor: pointer;
  padding: 9px 12px;
  font-size: 11.5px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
}
.group-head:hover {
  background: var(--hover);
  color: var(--ink);
}
.group-head .chev {
  transition: transform 0.16s ease;
}
.group-head.open .chev {
  transform: rotate(90deg);
}
.group-head .n {
  margin-left: auto;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
/* ── 历史视图 ── */
.hist-group {
  border-bottom: 1px solid var(--line);
}
.hg-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: none;
  background: transparent;
  font-size: 11.5px;
  font-family: inherit;
  color: var(--muted);
  text-align: left;
  cursor: pointer;
}
.hg-head:hover {
  background: var(--hover);
}
.hg-head .chev {
  flex: none;
  transition: transform 0.16s ease;
}
.hg-head.open .chev {
  transform: rotate(90deg);
}
/* 自动切过来的那一轮：组头用暖色底闪两下后淡出（与历史定位的暖黄同一语义）。 */
.hg-head.auto-hit {
  animation: hg-auto-hit 3.6s ease-out both;
}
@keyframes hg-auto-hit {
  0%,
  30% {
    background: color-mix(in oklab, var(--warn) 22%, transparent);
  }
  15%,
  45% {
    background: color-mix(in oklab, var(--warn) 8%, transparent);
  }
  60% {
    background: color-mix(in oklab, var(--warn) 18%, transparent);
  }
  100% {
    background: transparent;
  }
}
@media (prefers-reduced-motion: reduce) {
  .hg-head.auto-hit {
    animation: none;
    background: color-mix(in oklab, var(--warn) 14%, transparent);
  }
}
.hg-head .rname {
  color: var(--ink);
  font-weight: 500;
  font-size: 12px;
}
.hg-head .del {
  margin-left: auto;
  color: var(--faint);
  opacity: 0;
  font-size: 11px;
  flex: none;
}
.hg-head:hover .del {
  opacity: 1;
}
.hg-head .del:hover {
  color: var(--danger);
}
.retention {
  padding: 12px;
  font-size: 11px;
  color: var(--faint);
  line-height: 1.7;
  text-align: center;
}
/* ── 底条 ── */
/* 全局备注输入区：就地展开在底条上方，样式贴合面板。 */
.ann-composer {
  border-top: 1px solid var(--line);
  padding: 8px 10px;
  background: var(--surface-2);
}
.ann-composer-note {
  width: 100%;
  box-sizing: border-box;
  min-height: 54px;
  max-height: 140px;
  resize: none;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--bg);
  color: var(--ink);
  font: 12.5px/1.6 inherit;
  padding: 6px 8px;
  outline: none;
}
.ann-composer-note:focus {
  border-color: var(--accent);
}
.ann-composer-foot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
.ann-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 36px;
  padding: 0 7px;
  border-top: 1px solid var(--line);
  box-sizing: border-box;
}
.btn-primary {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: var(--accent-on);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.14s ease;
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}
/* 禁用态中性灰，不用墨蓝降透明度（避免与「可用但次要」混淆，方案 §3.4）。 */
.btn-primary:disabled {
  background: var(--surface-2);
  color: var(--faint);
  box-shadow: inset 0 0 0 1px var(--line);
  cursor: default;
}
.btn-ghost {
  flex: none;
  height: 24px;
  padding: 0 9px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  color: var(--muted);
  background: transparent;
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  transition:
    background 0.14s ease,
    color 0.14s ease;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--hover);
  color: var(--ink);
}
.btn-ghost:disabled {
  opacity: 0.45;
  cursor: default;
}
.btn-ghost.wide {
  flex: 1 1 auto;
  justify-content: center;
}
.menu-wrap {
  position: relative;
  display: flex;
  flex: none;
}
.menu {
  position: absolute;
  right: 0;
  bottom: 30px;
  min-width: 132px;
  padding: 4px;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  box-shadow: var(--shadow-pop);
  z-index: 40;
}
.menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}
.menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 9px;
  border: none;
  background: transparent;
  border-radius: 6px;
  font-size: 12.5px;
  font-family: inherit;
  color: var(--ink);
  cursor: pointer;
}
.menu button:hover:not(:disabled) {
  background: var(--hover);
}
.menu button:disabled {
  color: var(--faint);
  cursor: default;
}
.mini {
  flex: none;
  height: 21px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  font-size: 11.5px;
  font-family: inherit;
  color: var(--muted);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  cursor: pointer;
}
.mini:hover {
  background: var(--hover);
  color: var(--ink);
}
.mini.danger:hover {
  color: var(--danger);
}
.icon-btn {
  width: 21px;
  height: 21px;
  border-radius: 5px;
  border: none;
  background: transparent;
  display: grid;
  place-items: center;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
}
.icon-btn:hover {
  background: var(--hover);
  color: var(--ink);
}
</style>

<style>
/* 抽屉挂在 body 上（teleport），不能 scoped。 */
.ann-sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  background: var(--backdrop);
}
.ann-sheet {
  width: min(660px, 78vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-2);
  border-radius: 12px;
  box-shadow: var(--shadow-win);
  overflow: hidden;
}
.ann-sheet header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 15px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
}
.ann-sheet header .s-sub {
  font-size: 11.5px;
  color: var(--faint);
  font-weight: 400;
}
.ann-sheet header .icon-btn {
  margin-left: auto;
}
.ann-sheet pre {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 15px;
  font: 11.5px/1.75 var(--font-mono);
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
}
.ann-sheet footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 11px 15px;
  border-top: 1px solid var(--line);
}
</style>
