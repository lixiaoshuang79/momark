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

    <!-- 单页悬浮胶囊 / Dock 新增时展开的网址栏 -->
    <addr-wrap v-if="urlPages.length <= 1 || dockAddrOpen" />

    <!-- 多网页态：右缘垂直 Dock -->
    <url-dock :pages="urlPages" :active-page-id="activePageId" />

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
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { useBrowserPanelStore } from '@/store/browserPanel'
import WebviewPage from './webviewPage.vue'
import AddrWrap from './addrWrap.vue'
import UrlDock from './urlDock.vue'

const bpStore = useBrowserPanelStore()
const { urlPages, activePageId, dockAddrOpen } = storeToRefs(bpStore)

const activePage = computed(() => urlPages.value.find((p) => p.id === activePageId.value) ?? null)

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
