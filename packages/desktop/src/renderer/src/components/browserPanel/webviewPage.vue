<template>
  <webview
    ref="webviewEl"
    class="bp-webview"
    :class="{ active }"
    :src="initialSrc"
    :data-page-id="page.id"
    partition="persist:panel"
    allowpopups="false"
  />
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, ref } from 'vue'
import type { WebviewTag } from 'electron'
import { useBrowserPanelStore, ZOOM_MIN, type WebPage } from '@/store/browserPanel'

/**
 * 单页 webview 实例（每 Dock 页一个，display 切换保活登录态/滚动/历史）。
 * 事件映射（report 3.md §4）：did-start-loading/did-stop-loading → 墨蓝进度线，
 * did-fail-load（isMainFrame && errorCode !== -3）→ 失败页 + 重试，
 * did-navigate / did-navigate-in-page / page-title-updated / page-favicon-updated
 * → 页面状态。
 *
 * round17 两块新职责：
 *   1. SPA 路由同步——pushState/replaceState 只触发 did-navigate-in-page，
 *      漏听会让底部地址栏永远停在整页导航的旧地址（用户报的「登录后还是 /login」）。
 *   2. 缩放——page.zoom 是唯一状态源（快捷键经主进程回传 / 工具栏 / 适应宽度
 *      反算），本组件只负责把它落到 setZoomFactor；「适应宽度」在这里量真实
 *      布局宽度反算因子。
 */

const props = defineProps<{
  page: WebPage
  active: boolean
}>()

const bpStore = useBrowserPanelStore()
const webviewEl = ref<WebviewTag | null>(null)

// guest 自己上报过的地址（整页导航 + SPA 路由各一份来源）。地址栏回车走
// 同一个 page.url，靠它区分「guest 告诉我它去哪了」与「用户要求去某处」，
// 避免把 SPA 写入的地址当成导航指令再 loadURL 一次（会丢掉登录后的页面状态）。
const guestReportedUrl = ref('')

/**
 * src 只在挂载时取一次快照，之后绝不随 page.url 变化重新绑定。
 * 坑：<webview> 的 src 是「导航指令」而非普通属性——Vue 的 patchDOMProp 写
 * el.src 会走 WebViewElement 的 src setter → Electron 立即 loadURL 一次整页
 * 导航。SPA pushState 让 page.url 变化后，若 src 仍在响应式绑定中，地址栏看似
 * 正确、页面却被重新加载（本例直接落到 404），登录态与页面状态全丢。
 * 因此所有后续导航一律走下面 watcher 里显式的 loadURL。
 */
const initialSrc = props.page.url

// ── 页面状态事件 ─────────────────────────────────────────────────────

const onStartLoading = () => {
  bpStore.UPDATE_PAGE_STATE(props.page.id, { loading: true, error: null })
}

const onStopLoading = () => {
  bpStore.UPDATE_PAGE_STATE(props.page.id, { loading: false })
  // 页面加载完成后补一次缩放（zoom 属于会话/源维度，跨导航可能被重置）。
  applyZoom()
  scheduleFit()
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
  if (!e.url) return
  guestReportedUrl.value = e.url
  bpStore.UPDATE_PAGE_STATE(props.page.id, { url: e.url, error: null })
  contentWidth = null
  scheduleFit([220, 900])
}

// round17（用户反馈「已经 login 了网址栏还显示 login」）：SPA 的路由切换
// 走 history.pushState/replaceState，Chromium 只发 did-navigate-in-page。
const onNavigateInPage = (event: Event) => {
  const e = event as unknown as { url: string; isMainFrame: boolean }
  if (!e.isMainFrame || !e.url) return
  guestReportedUrl.value = e.url
  bpStore.UPDATE_PAGE_STATE(props.page.id, { url: e.url })
  contentWidth = null
  // 换页后内容多为异步渲染，量两次（首屏 + 稳定后）。
  scheduleFit([220, 900])
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
  applyZoom()
  scheduleFit([120, 600])
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

// ── 缩放 ─────────────────────────────────────────────────────────────
// 只读取 store 的 page.zoom 下发；DOM 侧不做任何自己的缩放计算，
// 避免「谁写谁读」两套状态互相覆盖。

const applyZoom = (): void => {
  const el = webviewEl.value
  if (!el) return
  try {
    el.setZoomFactor(props.page.zoom)
  } catch {
    // 尚未 attach 完成时抛错，dom-ready / did-stop-loading 会补一次。
  }
}

// ── 适应宽度 ─────────────────────────────────────────────────────────
// 目标是让「内容 CSS 宽」正好等于视口宽：新 zoom = 实际 zoom × 视口 / 内容。
// 两个关键点：
// ① 用「实际 zoom」而不是 getZoomFactor 的回显值——Blink 把页面缩放钳在
//    [0.25, 5]，请求 0.22 时元素按 0.25 布局而回显仍是 0.22，用它反算会永远
//    差一截、收敛不到位。实际 zoom = 元素宽 / innerWidth。
// ② 内容宽只在「内容比视口宽」时量得到（scrollWidth 被视口撑大，视口够宽时
//    等于视口宽）：量到就记下来复用。否则面板变宽后 need 退化成视口宽，页面
//    会停在窄面板算出的比例上再也回不来。

// 隐藏态（display:none）的 webview 量不到布局，clientWidth 为 0，直接跳过。
const FIT_MIN_VIEWPORT = 50
// 溢出不足 4px 算噪声，不用它当内容宽的依据（会让比例来回微调）。
const FIT_MIN_OVERFLOW = 4
// 目标与当前比例的差小于 2% 就不动作：几像素的溢出不值得整页重排。落到缩放
// 下限时目标会被 ZOOM_MIN 钳成与当前相等，同样不动作。
const FIT_DEAD_ZONE = 0.02

// 本页内容的 CSS 宽（null = 还没量到，即内容装得下）。整页/页内导航后作废重测。
let contentWidth: number | null = null

let fitTimers: number[] = []
let fitRunning = false
let fitPending = false

const clearFitTimers = (): void => {
  fitTimers.forEach((t) => window.clearTimeout(t))
  fitTimers = []
}

const scheduleFit = (delays: number[] = [220]): void => {
  if (!props.page.fitWidth) return
  clearFitTimers()
  fitTimers = delays.map((d) =>
    window.setTimeout(() => {
      runFit()
    }, d)
  )
}

const runFit = async (): Promise<void> => {
  const el = webviewEl.value
  if (!el || !props.page.fitWidth) return
  if (fitRunning) {
    fitPending = true
    return
  }
  fitRunning = true
  try {
    const metrics = (await el.executeJavaScript(`(() => {
      const doc = document.documentElement
      const body = document.body
      if (!doc) return { avail: 0, need: 0, view: 0 }
      const avail = doc.clientWidth
      let need = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0)
      // 后台模板常给 html/body 加 overflow:hidden，被裁掉的内容量不进
      // scrollWidth，用 body 直接子元素的右边界兜底。
      if (need <= avail && body && getComputedStyle(doc).overflowX === 'hidden') {
        for (const child of Array.from(body.children)) {
          const node = child
          if (!(node instanceof HTMLElement)) continue
          if (node.offsetWidth > 0) need = Math.max(need, node.offsetLeft + node.offsetWidth)
        }
      }
      return { avail, need, view: window.innerWidth }
    })()`)) as { avail: number; need: number; view: number } | undefined

    if (!metrics || metrics.avail < FIT_MIN_VIEWPORT) return

    // 内容比视口宽时 need 就是内容宽，记下来供面板变宽后复用（见文件头说明）。
    if (metrics.need > metrics.avail + FIT_MIN_OVERFLOW) contentWidth = metrics.need
    // 量不到内容宽（内容装得下）就什么都不做，绝不放大窄页面。
    if (!contentWidth) return

    // 实际 zoom（元素宽 / 视口 CSS 宽）；量不到就按 100% 估，下一次触发修正。
    const elementWidth = el.getBoundingClientRect().width
    const effective = metrics.view > 0 ? elementWidth / metrics.view : 1
    const target = Math.min(1, Math.max(ZOOM_MIN, effective * (metrics.avail / contentWidth)))
    // 死区拿 store 的比例比较，不用反算的实际值：guest 视口在面板变宽后
    // 会滞后一档，拿它比较会把「该放大」误判成「无需动作」。
    const current = props.page.zoom
    if (Math.abs(target - current) / current < FIT_DEAD_ZONE) return
    bpStore.SET_PAGE_ZOOM(props.page.id, target)
    // 用户刚点过「适应宽度」时把浮标细化成实际比例；自动反算不打扰。
    if (bpStore.zoomHint) {
      bpStore.SHOW_ZOOM_HINT(`适应宽度 · ${Math.round(Math.min(1, target) * 100)}%`)
    }
  } catch {
    // 页面未就绪 / 导航竞态下 executeJavaScript 会被拒，等下次事件重试。
  } finally {
    fitRunning = false
    if (fitPending) {
      fitPending = false
      runFit()
    }
  }
}

// ── 监听装配 ─────────────────────────────────────────────────────────

let resizeObserver: ResizeObserver | null = null

const mountListeners = (el: WebviewTag) => {
  el.addEventListener('did-start-loading', onStartLoading)
  el.addEventListener('did-stop-loading', onStopLoading)
  el.addEventListener('did-fail-load', onFailLoad)
  el.addEventListener('did-navigate', onNavigate)
  el.addEventListener('did-navigate-in-page', onNavigateInPage)
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
  el.removeEventListener('did-navigate-in-page', onNavigateInPage)
  el.removeEventListener('page-title-updated', onTitleUpdated)
  el.removeEventListener('page-favicon-updated', onFaviconUpdated)
  el.removeEventListener('dom-ready', onDomReady)
  el.removeEventListener('render-process-gone', onRenderProcessGone)
  el.removeEventListener('crashed', onCrashed)
}

onMounted(() => {
  const el = webviewEl.value
  if (!el) return
  mountListeners(el)
  // 面板宽度拖动、侧栏展开/收起、切到本页（display:none → flex）都会改变
  // 元素尺寸，这里统一重算适应宽度。
  resizeObserver = new ResizeObserver(() => {
    scheduleFit([260])
  })
  resizeObserver.observe(el)
})

onBeforeUnmount(() => {
  const el = webviewEl.value
  if (el) unmountListeners(el)
  resizeObserver?.disconnect()
  resizeObserver = null
  clearFitTimers()
})

// 缩放因子下发（store → guest）。
watch(() => props.page.zoom, applyZoom)

// 「适应宽度」开关打开时立即量一次；关掉时无需复位（保留当前比例，
// 用户可再用 Cmd+0 回到 100%）。
watch(
  () => props.page.fitWidth,
  (on) => {
    if (on) scheduleFit([80, 400])
    else clearFitTimers()
  }
)

// 切回本页时补一次（display 变化会触发 ResizeObserver，这里兜住
// ResizeObserver 尚未回调就被切换的边角情况）。
watch(
  () => props.active,
  (on) => {
    if (on) {
      applyZoom()
      scheduleFit([120, 600])
    }
  }
)

// 底部地址栏回车导航：显式 loadURL（Electron 推荐做法，不依赖 src 属性
// 观察）。guest 自导航（did-navigate 回写 url）时 getURL() === next，跳过，
// 避免重复加载；重定向竞态下最多一次冗余导航（无害）。
watch(
  () => props.page.url,
  (next) => {
    if (!next) return
    const el = webviewEl.value
    if (!el) return
    // guest 自己上报的地址不是导航指令（SPA pushState 与整页导航都走这里）。
    if (next === guestReportedUrl.value) return
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
