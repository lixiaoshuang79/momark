<template>
  <!-- 右侧栏分隔线（feat/right-panel-redesign，DESIGN-NOTES §1「分隔线交互」）：
       9px 热区、视觉 1px；悬停 100ms 后 2px 墨蓝线；拖动时读数气泡 + ⅓/½/默认
       吸附线；越过上下限有阻尼、变警示色，松手回弹。双击恢复默认，键盘可调。 -->
  <div
    ref="splitterEl"
    class="splitter"
    :class="{ drag: dragging, kbd: kbdActive, limit: !!readout.limit, overlay: panelOverlay }"
    :style="{ right: `${panelWidthPx - 4.5}px` }"
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-label="t('rightPanel.divider.label')"
    :aria-valuemin="geometry.min"
    :aria-valuemax="geometry.max"
    :aria-valuenow="panelWidthPx"
    :aria-valuetext="chipText"
    :title="dragging ? undefined : t('rightPanel.divider.title')"
    @pointerdown="onPointerDown"
    @dblclick="onReset"
    @keydown="onKeydown"
  >
    <i class="sp-line" />
    <span class="sp-chip">{{ chipText }}</span>
  </div>
  <div class="splitter-snaps" :class="{ show: dragging }" aria-hidden="true">
    <i
      v-for="line of lines"
      :key="line.id"
      class="sp-snap"
      :class="{ hit: readout.snapped === line.id }"
      :style="{ right: `${line.px}px` }"
    >
      <b>{{ snapLabel(line.id) }}</b>
    </i>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useSplitStore } from '@/store/split'
import { useWorkspaceStore } from '@/store/workspace'
import { t } from '../i18n'
import {
  KEY_STEP,
  KEY_STEP_FAST,
  PANEL_LIMITS,
  clampWidth,
  dragWidth,
  snapLines,
  type LimitReason,
  type SnapId
} from '@/store/panelGeometry'

const splitStore = useSplitStore()
const workspaceStore = useWorkspaceStore()
const { panelWidthPx, panelOverlay, panelAvail, panelKind, geometry } = storeToRefs(workspaceStore)

const splitterEl = ref<HTMLElement | null>(null)
const dragging = ref(false)
const kbdActive = ref(false)
const readout = ref<{ snapped: SnapId | null; limit: LimitReason; settle: number }>({
  snapped: null,
  limit: null,
  settle: 0
})

const lines = computed(() => snapLines(panelAvail.value, panelKind.value, geometry.value))

const snapLabel = (id: SnapId): string => t(`rightPanel.divider.snap.${id}`)

const chipText = computed(() => {
  const { limit } = readout.value
  if (dragging.value && limit === 'min')
    return t('rightPanel.divider.min', { px: geometry.value.min })
  if (dragging.value && limit === 'max') return t('rightPanel.divider.max')
  if (dragging.value && limit === 'editor') {
    return t('rightPanel.divider.editor', { px: PANEL_LIMITS.editorMin })
  }
  const avail = panelAvail.value || 1
  return `${Math.round((panelWidthPx.value / avail) * 100)}% · ${panelWidthPx.value}px`
})

// ── 指针拖动 ────────────────────────────────────────────────────────────
let originRight = 0

const widthAt = (clientX: number): number => originRight - clientX

const onPointerDown = (event: PointerEvent): void => {
  if (event.button !== 0) return
  const winBody = splitterEl.value?.closest('.win-body') as HTMLElement | null
  if (!winBody) return
  originRight = winBody.getBoundingClientRect().right
  dragging.value = true
  splitStore.draggingSplit = true
  readout.value = { snapped: null, limit: null, settle: panelWidthPx.value }
  const el = splitterEl.value
  el?.setPointerCapture?.(event.pointerId)
  event.preventDefault()
  el?.addEventListener('pointermove', onPointerMove)
  el?.addEventListener('pointerup', onPointerUp)
  el?.addEventListener('pointercancel', onPointerUp)
}

const onPointerMove = (event: PointerEvent): void => {
  if (!dragging.value) return
  const result = dragWidth(
    widthAt(event.clientX),
    panelAvail.value,
    panelKind.value,
    geometry.value
  )
  readout.value = { snapped: result.snapped, limit: result.limit, settle: result.settle }
  workspaceStore.SET_PANEL_DRAG_WIDTH(result.px)
}

const detach = (): void => {
  const el = splitterEl.value
  el?.removeEventListener('pointermove', onPointerMove)
  el?.removeEventListener('pointerup', onPointerUp)
  el?.removeEventListener('pointercancel', onPointerUp)
}

const onPointerUp = (): void => {
  if (!dragging.value) return
  detach()
  dragging.value = false
  // 先放开 draggingSplit（恢复宽度过渡），再落定：越界时面板会用 380ms 回弹到边界。
  splitStore.draggingSplit = false
  const settle = readout.value.settle || panelWidthPx.value
  readout.value = { snapped: null, limit: null, settle }
  workspaceStore.COMMIT_PANEL_WIDTH(settle)
}

const onReset = (): void => {
  workspaceStore.RESET_PANEL_RATIO()
  flashChip()
}

// ── 键盘：←/→ 16px（⇧ 64px），↩ / Home 恢复默认 ─────────────────────────
let kbdTimer: ReturnType<typeof setTimeout> | null = null
const flashChip = (): void => {
  kbdActive.value = true
  if (kbdTimer) clearTimeout(kbdTimer)
  kbdTimer = setTimeout(() => {
    kbdActive.value = false
    kbdTimer = null
  }, 900)
}

const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Enter' || event.key === 'Home') {
    event.preventDefault()
    onReset()
    return
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const step = event.shiftKey ? KEY_STEP_FAST : KEY_STEP
  // 分隔线在面板左缘：← 让面板变宽，→ 变窄
  const next = panelWidthPx.value + (event.key === 'ArrowLeft' ? step : -step)
  workspaceStore.COMMIT_PANEL_WIDTH(clampWidth(next, geometry.value))
  flashChip()
}

onBeforeUnmount(() => {
  detach()
  if (dragging.value) splitStore.draggingSplit = false
  workspaceStore.SET_PANEL_DRAG_WIDTH(null)
  if (kbdTimer) clearTimeout(kbdTimer)
})
</script>
