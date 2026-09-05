<template>
  <div
    class="bp-addrwrap"
    :class="{ open: dockAddrOpen }"
    @mouseleave="scheduleCollapse"
    @mouseenter="cancelCollapse"
  >
    <div class="bp-plus" title="搜索 Google 或输入网址" @click.stop="onPlusClick">
      <svg
        class="bp-plus-ic"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
      >
        <path d="M7 2v10M2 7h10" />
      </svg>
      <span class="bp-bar">
        <svg class="gicon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
          />
          <path
            fill="#34A853"
            d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
          />
          <path
            fill="#FBBC05"
            d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
          />
          <path
            fill="#EA4335"
            d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
          />
        </svg>
        <input
          ref="inputEl"
          v-model="inputText"
          placeholder="搜索 Google 或输入网址"
          aria-label="搜索或输入网址"
          @keydown.enter.prevent="go"
        />
        <button class="bp-go" @click.stop="go">前往</button>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { useBrowserPanelStore, resolveInput } from '@/store/browserPanel'
import notice from '@/services/notification'

/**
 * 单页悬浮「+」胶囊（PHASE2-SPEC §5）：34×34 卡片底描边 right:6px top:8px；
 * 点击生长为网址栏 width min(320px, 100% - 12px)（.46s --ease-grow）；
 * 含 Google 彩 G 图标 + 输入框 + 前往按钮；mouseleave 自动收起。
 * 输入判断：URL（含协议/域名样式无空格）→ 自动补 https://；否则 Google 搜索。
 */

const bpStore = useBrowserPanelStore()
const { dockAddrOpen } = storeToRefs(bpStore)

const inputEl = ref<HTMLInputElement | null>(null)
const inputText = ref('')
let leaveTimer: ReturnType<typeof setTimeout> | null = null

const onPlusClick = () => {
  bpStore.SET_DOCK_ADDR_OPEN(!dockAddrOpen.value)
  if (dockAddrOpen.value) {
    // 展开后聚焦输入框（无自动聚焦的是底部地址栏，这里展开即输入意图）。
    setTimeout(() => inputEl.value?.focus(), 60)
  }
}

const scheduleCollapse = () => {
  cancelCollapse()
  leaveTimer = setTimeout(() => {
    bpStore.SET_DOCK_ADDR_OPEN(false)
  }, 180)
}

const cancelCollapse = () => {
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
}

const go = async () => {
  const raw = inputText.value
  if (!raw.trim()) return
  const resolved = resolveInput(raw)
  const pageId = await bpStore.ADD_WEB_PAGE(raw)
  if (!pageId) return
  inputText.value = ''
  bpStore.SET_DOCK_ADDR_OPEN(false)
  if (resolved?.includes('google.com/search')) {
    notice.notify({ message: `Google 搜索「${raw.trim()}」`, type: 'primary', time: 2000 })
  } else {
    const target = (resolved ?? raw.trim()).replace(/^https?:\/\//i, '')
    notice.notify({ message: `正在打开 https://${target} …`, type: 'primary', time: 2000 })
  }
}

watch(dockAddrOpen, (open) => {
  if (!open) cancelCollapse()
})

onBeforeUnmount(cancelCollapse)
</script>
