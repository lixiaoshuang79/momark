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
import { useBrowserPanelStore } from '@/store/browserPanel'

/**
 * 右栏分隔线：8px 命中区、中间 1px --line（hover 变 accent）；pointer capture
 * 拖动。两种场景共用：文档分屏（写 split.width，240px~60% 窗宽，≥90% 自动关闭）
 * 与网页模式（写 bp.urlWidth，同一夹逼区间）。拖动结束不弹 toast。
 */

const splitStore = useSplitStore()
const bpStore = useBrowserPanelStore()
const splitterEl = ref<HTMLElement | null>(null)

let dragging = false

const panelWidthFrom = (clientX: number) => {
  const el = splitterEl.value
  const winBody = el?.closest('.win-body') as HTMLElement | null
  if (!winBody) return
  const rect = winBody.getBoundingClientRect()
  const w = rect.right - clientX
  if (splitStore.active) {
    splitStore.SET_SPLIT_WIDTH(w) // 内部处理 240/60% 夹逼与 ≥90% 自动关闭
  } else {
    bpStore.SET_URL_WIDTH(w)
  }
}

const onPointerDown = (event: PointerEvent) => {
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
}

onBeforeUnmount(() => {
  const el = splitterEl.value
  el?.removeEventListener('pointermove', onPointerMove)
  el?.removeEventListener('pointerup', onPointerUp)
  el?.removeEventListener('pointercancel', onPointerUp)
})
</script>
