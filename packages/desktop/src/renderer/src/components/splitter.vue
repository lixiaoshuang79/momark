<template>
  <div
    ref="splitterEl"
    class="splitter"
    title="左右拖动，调整两栏宽度"
    @pointerdown="onPointerDown"
  />
</template>

<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import { useSplitStore } from '@/store/split'
import notice from '@/services/notification'

/**
 * 双屏分栏分隔线（PHASE2-SPEC §3.4）：8px 命中区、中间 1px --line
 * （hover 变 accent）；pointer capture 拖动：右栏 240px ≤ w ≤ 60% 窗宽，
 * 拖到 ≥90% 窗宽自动关闭分屏；拖动结束 toast 报告宽度。
 */

const splitStore = useSplitStore()
const splitterEl = ref<HTMLElement | null>(null)

let dragging = false

const panelWidthFrom = (clientX: number) => {
  const el = splitterEl.value
  const winBody = el?.closest('.win-body') as HTMLElement | null
  if (!winBody) return
  const rect = winBody.getBoundingClientRect()
  const w = rect.right - clientX
  splitStore.SET_SPLIT_WIDTH(w) // 内部处理 240/60% 夹逼与 ≥90% 自动关闭
}

const onPointerDown = (event: PointerEvent) => {
  if (!splitStore.active) return
  dragging = true
  splitStore.draggingSplit = true
  const el = splitterEl.value
  if (el && typeof el.setPointerCapture === 'function') {
    el.setPointerCapture(event.pointerId)
  }
  event.preventDefault()
  el?.addEventListener('pointermove', onPointerMove)
  el?.addEventListener('pointerup', onPointerUp)
  el?.addEventListener('pointercancel', onPointerUp)
}

const onPointerMove = (event: PointerEvent) => {
  if (!dragging) return
  panelWidthFrom(event.clientX)
}

const onPointerUp = () => {
  if (!dragging) return
  dragging = false
  splitStore.draggingSplit = false
  const el = splitterEl.value
  el?.removeEventListener('pointermove', onPointerMove)
  el?.removeEventListener('pointerup', onPointerUp)
  el?.removeEventListener('pointercancel', onPointerUp)
  if (splitStore.active) {
    notice.notify({
      message: `分栏宽度已调整（${splitStore.width}px）`,
      type: 'primary',
      time: 2000
    })
  }
}

onBeforeUnmount(() => {
  const el = splitterEl.value
  el?.removeEventListener('pointermove', onPointerMove)
  el?.removeEventListener('pointerup', onPointerUp)
  el?.removeEventListener('pointercancel', onPointerUp)
})
</script>
