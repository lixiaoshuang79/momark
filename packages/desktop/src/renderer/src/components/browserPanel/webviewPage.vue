<template>
  <webview
    ref="webviewEl"
    class="bp-webview"
    :class="{ active }"
    :src="page.url"
    :data-page-id="page.id"
    partition="persist:panel"
    allowpopups="false"
  />
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, ref } from 'vue'
import type { WebviewTag } from 'electron'
import { useBrowserPanelStore, type WebPage } from '@/store/browserPanel'

/**
 * 单页 webview 实例（每 Dock 页一个，display 切换保活登录态/滚动/历史）。
 * 事件映射（report 3.md §4）：did-start-loading/did-stop-loading → 墨蓝进度线，
 * did-fail-load（isMainFrame && errorCode !== -3）→ 失败页 + 重试，
 * did-navigate / page-title-updated / page-favicon-updated → 页面状态。
 */

const props = defineProps<{
  page: WebPage
  active: boolean
}>()

const bpStore = useBrowserPanelStore()
const webviewEl = ref<WebviewTag | null>(null)

const onStartLoading = () => {
  bpStore.UPDATE_PAGE_STATE(props.page.id, { loading: true, error: null })
}

const onStopLoading = () => {
  bpStore.UPDATE_PAGE_STATE(props.page.id, { loading: false })
}

const onFailLoad = (event: Event) => {
  const e = event as unknown as {
    errorCode: number
    errorDescription: string
    validatedURL: string
    isMainFrame: boolean
  }
  if (!e.isMainFrame) return
  if (e.errorCode === -3) return // ERR_ABORTED：用户中断/新导航，忽略
  bpStore.UPDATE_PAGE_STATE(props.page.id, {
    loading: false,
    error: e.errorDescription || `加载失败（错误码 ${e.errorCode}）`
  })
}

const onNavigate = (event: Event) => {
  const e = event as unknown as { url: string }
  if (e.url) bpStore.UPDATE_PAGE_STATE(props.page.id, { url: e.url, error: null })
}

const onTitleUpdated = (event: Event) => {
  const e = event as unknown as { title: string }
  if (e.title) bpStore.UPDATE_PAGE_STATE(props.page.id, { title: e.title })
}

const onFaviconUpdated = (event: Event) => {
  const e = event as unknown as { favicons: string[] }
  if (e.favicons && e.favicons.length) {
    bpStore.UPDATE_PAGE_STATE(props.page.id, { favicon: e.favicons[0] })
  }
}

const onDomReady = () => {
  const el = webviewEl.value
  if (!el) return
  // 主进程注册 pageId → guest webContents 映射（bp:register）。
  window.bp.register(props.page.id, el.getWebContentsId())
}

// guest 渲染进程崩溃兜底（report 3.md §5.10）：显示失败页 + 重试，不静默。
const onRenderProcessGone = (event: Event) => {
  const e = event as unknown as { details?: { reason?: string } }
  bpStore.UPDATE_PAGE_STATE(props.page.id, {
    loading: false,
    error: `页面进程异常退出（${e.details?.reason ?? 'unknown'}）`
  })
}

const onCrashed = () => {
  bpStore.UPDATE_PAGE_STATE(props.page.id, { loading: false, error: '页面已崩溃' })
}

const mountListeners = (el: WebviewTag) => {
  el.addEventListener('did-start-loading', onStartLoading)
  el.addEventListener('did-stop-loading', onStopLoading)
  el.addEventListener('did-fail-load', onFailLoad)
  el.addEventListener('did-navigate', onNavigate)
  el.addEventListener('page-title-updated', onTitleUpdated)
  el.addEventListener('page-favicon-updated', onFaviconUpdated)
  el.addEventListener('dom-ready', onDomReady)
  el.addEventListener('render-process-gone', onRenderProcessGone)
  el.addEventListener('crashed', onCrashed)
}

const unmountListeners = (el: WebviewTag) => {
  el.removeEventListener('did-start-loading', onStartLoading)
  el.removeEventListener('did-stop-loading', onStopLoading)
  el.removeEventListener('did-fail-load', onFailLoad)
  el.removeEventListener('did-navigate', onNavigate)
  el.removeEventListener('page-title-updated', onTitleUpdated)
  el.removeEventListener('page-favicon-updated', onFaviconUpdated)
  el.removeEventListener('dom-ready', onDomReady)
  el.removeEventListener('render-process-gone', onRenderProcessGone)
  el.removeEventListener('crashed', onCrashed)
}

onMounted(() => {
  const el = webviewEl.value
  if (el) mountListeners(el)
})

onBeforeUnmount(() => {
  const el = webviewEl.value
  if (el) unmountListeners(el)
})

// 底部地址栏回车导航：显式 loadURL（Electron 推荐做法，不依赖 src 属性
// 观察）。guest 自导航（did-navigate 回写 url）时 getURL() === next，跳过，
// 避免重复加载；重定向竞态下最多一次冗余导航（无害）。
watch(
  () => props.page.url,
  (next) => {
    if (!next) return
    const el = webviewEl.value
    if (!el) return
    try {
      if (el.getURL() === next) return
      el.loadURL(next).catch(() => {
        // 失败由 did-fail-load 兜底呈现。
      })
    } catch {
      // getURL 在未挂载完成时可能抛错，忽略。
    }
    bpStore.UPDATE_PAGE_STATE(props.page.id, { loading: true, error: null })
  }
)
</script>
