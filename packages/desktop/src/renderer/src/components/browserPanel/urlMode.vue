<template>
  <div class="bp-url">
    <!-- 每页一个 webview 实例，display 切换保活（登录态/滚动/历史） -->
    <webview-page
      v-for="page of urlPages"
      :key="page.id"
      :page="page"
      :active="page.id === activePageId"
    />

    <div v-if="urlPages.length === 0" class="bp-url-empty">
      <mo-icon name="i-globe" />
      <p>点击右上角分屏按钮搜索或输入网址<br />即可在面板内浏览网页</p>
    </div>

    <!-- 单页态：右上角悬浮「+」胶囊（多页态由右缘 Dock 末尾的「+」承担） -->
    <addr-wrap v-if="urlPages.length <= 1" />

    <!-- 多网页态：右缘垂直 Dock -->
    <url-dock :pages="urlPages" :active-page-id="activePageId" />

    <!-- round17：缩放浮标（快捷键 Cmd +/-/0 与「适应宽度」的即时反馈，
         自动隐藏；放顶部居中避开右下角的 url-dock 与文档模式的缩放条） -->
    <transition name="bp-hint">
      <div v-if="zoomHint" :key="zoomHint.seq" class="bp-zoom-hint">
        {{ zoomHint.text }}
      </div>
    </transition>

    <!-- 加载失败：原因 + 重试（-3 忽略、isMainFrame 判定已在上游处理） -->
    <div v-if="activePage && activePage.error" class="bp-fail">
      <mo-icon name="i-warn" />
      <p>无法打开网址</p>
      <p class="why">
        {{ activePage.error }}
      </p>
      <button class="retry" @click="retry">重试</button>
    </div>

    <!-- 首载加载态（进度线由 index.vue 的 bp-track 统一驱动） -->
    <div
      v-else-if="activePage && activePage.loading && !loadedOnce.has(activePage.id)"
      class="bp-loading"
    >
      <div class="spin" />
      <p>正在加载…</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { useBrowserPanelStore } from '@/store/browserPanel'
import WebviewPage from './webviewPage.vue'
import AddrWrap from './addrWrap.vue'
import UrlDock from './urlDock.vue'

const bpStore = useBrowserPanelStore()
const { urlPages, activePageId, zoomHint } = storeToRefs(bpStore)

const activePage = computed(() => urlPages.value.find((p) => p.id === activePageId.value) ?? null)

// 缩放浮标自动隐藏：seq 变化（同文案连按）也会重置计时。
let hintTimer: number | null = null
watch(
  () => zoomHint.value?.seq,
  (seq) => {
    if (hintTimer !== null) window.clearTimeout(hintTimer)
    if (!seq) {
      hintTimer = null
      return
    }
    hintTimer = window.setTimeout(() => {
      bpStore.zoomHint = null
      hintTimer = null
    }, 1400)
  }
)
onBeforeUnmount(() => {
  if (hintTimer !== null) window.clearTimeout(hintTimer)
})

// 完成过一次加载的页面不再显示整层 loading 覆盖（后续导航只显示进度线）。
const loadedOnce = ref<Set<string>>(new Set())

watch(
  () => urlPages.value.map((p) => `${p.id}:${p.loading}:${!!p.error}`).join('|'),
  () => {
    for (const page of urlPages.value) {
      if (!page.loading && !page.error && !loadedOnce.value.has(page.id)) {
        const next = new Set(loadedOnce.value)
        next.add(page.id)
        loadedOnce.value = next
      }
    }
  },
  { immediate: true }
)

const retry = () => {
  const id = activePageId.value
  if (!id) return
  bpStore.UPDATE_PAGE_STATE(id, { loading: true, error: null })
  window.bp.reload(id)
}
</script>
