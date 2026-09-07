<template>
  <div
    class="split-drop-zone"
    :class="{
      show: !!splitStore.dragTabId,
      over: zoneHover,
      blocked
    }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="drop-message">
      <mo-icon name="i-partition" />
      <span>{{ blocked ? '该文件已在右侧分屏' : '拖动到此，分屏展开' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import MoIcon from '@/components/icons/MoIcon.vue'
import { useSplitStore } from '@/store/split'
import notice from '@/services/notification'

/**
 * 标签拖入投放区（PHASE2-SPEC §3.1/3.2）：任意标签 dragstart → 右缘 38%
 * 投放区（阴影/边框/文案「拖动到此，分屏展开」），无需预先打开右侧栏；
 * 目标已在右屏 → blocked 态（grayscale .35 + opacity .65 + 文案
 * 「该文件已在右侧分屏」，dropEffect none）。
 */

const splitStore = useSplitStore()
const zoneHover = ref(false)

const blocked = computed(
  () => !!splitStore.dragTabId && splitStore.active && splitStore.tabId === splitStore.dragTabId
)

const onDragOver = (event: DragEvent) => {
  if (!splitStore.dragTabId) return
  event.preventDefault()
  zoneHover.value = true
  event.dataTransfer!.dropEffect = blocked.value ? 'none' : 'move'
}

const onDragLeave = (event: DragEvent) => {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) {
    zoneHover.value = false
  }
}

const onDrop = (event: DragEvent) => {
  event.preventDefault()
  zoneHover.value = false
  const id = splitStore.dragTabId
  if (!id) return
  if (blocked.value) {
    notice.notify({ message: '该文件已在右侧分屏', type: 'primary', time: 2000 })
    splitStore.dragTabId = null
    return
  }
  const ok = splitStore.DRAG_TO_SPLIT(id)
  if (!ok) {
    notice.notify({ message: '该文件已在右侧分屏', type: 'primary', time: 2000 })
  }
  splitStore.dragTabId = null
}
</script>
