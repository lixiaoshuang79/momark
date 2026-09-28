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

    <!-- ── 历史视图 ── -->
    <div v-else class="ann-list">
      <div v-if="!store.historyGroups.length" class="empty">
        {{ t('annotation.empty.history') }}<br />{{ t('annotation.empty.historySub') }}
      </div>
      <template v-else>
        <section v-for="group in store.historyGroups" :key="group.round" class="hist-group">
          <button
            class="hg-head"
            :class="{ open: isHistoryOpen(group.round) }"
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
            <span class="del" @click.stop="deleteRound(group)">{{
              t('annotation.deleteRound')
            }}</span>
          </button>
          <template v-if="isHistoryOpen(group.round)">
            <div v-for="item in group.items" :key="item.id" class="hist-item">
              <div class="hi-quote" :title="item.anchor.quote">
                {{ inline(item.anchor.quote) }}
              </div>
              <div class="hi-note">
                {{ item.note }}
              </div>
              <div class="hi-foot">
                <button class="mini" @click.stop="store.restore(item.id)">
                  {{ t('annotation.action.restore') }}
                </button>
                <button class="mini danger" @click.stop="store.deleteArchived([item.id])">
                  {{ t('annotation.action.delete') }}
                </button>
              </div>
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
        <button
          v-if="store.copiedText"
          class="btn-ghost"
          :title="t('annotation.copiedTextTitle')"
          @click="openDrawer"
        >
          {{ t('annotation.copiedText') }}
        </button>
        <div class="menu-wrap">
          <button class="btn-ghost" @click.stop="archiveMenuOpen = !archiveMenuOpen">
            {{ t('annotation.archiveMenu') }}
            <svg
              width="8"
              height="8"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M4 6.5l4 4 4-4" />
            </svg>
          </button>
          <div v-if="archiveMenuOpen" class="menu">
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import notice from '@/services/notification'
import { t } from '../../i18n'
import AnnotationCard from './annotationCard.vue'
import { useAnnotationStore } from '@/store/annotation'

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

const copyButtonTitle = computed(() => {
  if (!store.copiedList.length) return undefined
  return t('annotation.copyAllHint', { n: counts.value.pending })
})

const inline = (text: string): string => text.replace(/\s+/g, ' ').trim()

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

const isHistoryOpen = (round: number): boolean => openRounds.value[round] !== false
const toggleHistory = (round: number): void => {
  openRounds.value = { ...openRounds.value, [round]: !isHistoryOpen(round) }
}

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
  document.removeEventListener('click', onDocumentClick)
  stopUnloadFlush?.()
  stopUnloadFlush = null
  if (copyDoneTimer) clearTimeout(copyDoneTimer)
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
.ann-head {
  padding: 12px 12px 9px;
  border-bottom: 1px solid var(--line);
  flex: none;
}
/* 「当前 / 历史」滑块：与顶部「网页/文档/标注」同一套视觉语言——
   白卡滑块在选项间滑动（同款回弹缓动），按钮只做文字颜色过渡。 */
.seg2 {
  position: relative;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  margin-bottom: 9px;
  background: var(--hover);
  height: 29px;
}
.seg2-slider {
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc(50% - 3px);
  height: calc(100% - 4px);
  background: var(--surface-2);
  border-radius: 6px;
  box-shadow: 0 0 0 1px var(--line-strong);
  transition: transform 0.34s cubic-bezier(0.3, 1.35, 0.4, 1);
  z-index: 0;
}
[data-theme='dark'] .seg2-slider {
  background: #3d5a80;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.seg2-slider.right {
  transform: translateX(calc(100% + 2px));
}
.seg2 button {
  position: relative;
  z-index: 1;
  flex: 1;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  border-radius: 6px;
  font-size: 12.5px;
  font-family: inherit;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.14s ease;
}
.seg2 button[aria-selected='true'] {
  color: var(--ink);
  font-weight: 500;
}
.counts {
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
.ann-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
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
.hist-item {
  padding: 9px 12px 9px 26px;
}
.hist-item + .hist-item {
  border-top: 1px solid var(--line);
}
.hi-quote {
  font: 11.5px/1.5 var(--font-mono);
  color: var(--faint);
  padding-left: 8px;
  border-left: 3px solid var(--line-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}
.hi-note {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--muted);
  margin-bottom: 6px;
}
.hi-foot {
  display: flex;
  gap: 6px;
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
