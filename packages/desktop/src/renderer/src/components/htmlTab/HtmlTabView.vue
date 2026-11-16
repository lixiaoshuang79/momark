<template>
  <!-- 只读 html 标签的视图：左编辑区与右侧分屏共用。页面跑在与编辑器内嵌 HTML 块
       同一隔离等级的沙箱帧里（allow-scripts、不透明源，引导页协议见
       public/html-frame.html）。 -->
  <div ref="hostRef" class="html-tab-view">
    <div v-if="turboMode" class="htv-turbo">
      <div class="htv-turbo-title">
        {{ t('editor.htmlTab.turboTitle') }}
      </div>
      <div class="htv-turbo-hint">
        {{ t('editor.htmlTab.turboHint') }}
      </div>
      <button v-if="pathname" class="htv-turbo-btn" type="button" @click="openExternally">
        {{ t('editor.htmlTab.openExternal') }}
      </button>
    </div>
    <template v-else>
      <iframe
        v-if="source"
        :key="frameKey"
        ref="frameRef"
        :src="shellUrl"
        sandbox="allow-scripts"
        :title="title"
        @load="deliverSource"
      />
      <!-- 工具条放右下角，悬停显示：右上角与 HTML 块的编辑按钮是同一个位置习惯，
           放那里会被误认成块工具。 -->
      <div class="htv-tools">
        <button
          class="htv-btn"
          type="button"
          :title="t('editor.htmlTab.zoomOut')"
          @click="zoomBy(1 / ZOOM_STEP)"
        >
          −
        </button>
        <span class="htv-pct" :title="t('editor.htmlTab.zoomReset')" @click="zoomTo(1)">{{
          zoomPct
        }}</span>
        <button
          class="htv-btn"
          type="button"
          :title="t('editor.htmlTab.zoomIn')"
          @click="zoomBy(ZOOM_STEP)"
        >
          +
        </button>
        <template v-if="pathname">
          <span class="htv-sep" />
          <button class="htv-btn htv-btn--text" type="button" :title="pathname" @click="reload">
            {{ t('editor.htmlTab.reload') }}
          </button>
          <button class="htv-btn htv-btn--text" type="button" @click="openExternally">
            {{ t('editor.htmlTab.openExternal') }}
          </button>
          <button class="htv-btn htv-btn--text" type="button" @click="showInFolder">
            {{ t('editor.htmlTab.showInFolder') }}
          </button>
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEditorStore } from '@/store/editor'
import { useHtmlTabsStore } from '@/store/htmlTabs'
import { usePreferencesStore } from '@/store/preferences'
import { t } from '../../i18n'

const props = defineProps<{ tabId: string }>()

const editorStore = useEditorStore()
const htmlTabsStore = useHtmlTabsStore()
const preferencesStore = usePreferencesStore()

const tab = computed(() => editorStore.tabs.find((item) => item.id === props.tabId) ?? null)
const source = computed(() => htmlTabsStore.sources.get(props.tabId) ?? null)
const pathname = computed(() => tab.value?.pathname ?? '')
const title = computed(() => tab.value?.filename ?? 'HTML')
const turboMode = computed(() => preferencesStore.turboMode === true)
const shellUrl = new URL('html-frame.html', document.baseURI).href

// 引导页收过一次源码就拒绝再投递（`written` 标志），而 src 永远是同一个引导页——
// 换标签、重新载入都必须换一个新 iframe，否则会停在上一份页面上。
const frameKey = computed(() => `${props.tabId}:${source.value?.revision ?? 0}`)

const hostRef = ref<HTMLDivElement | null>(null)
const frameRef = ref<HTMLIFrameElement | null>(null)

// 引导页解析完自己的脚本后才挂消息监听，所以等 load 再投递。内容被 document.write
// 重写会再触发一次 load，引导页自身去重，重复投递无害。
const deliverSource = () => {
  const html = source.value?.html
  const frame = frameRef.value
  if (!frame || !html) return
  frame.contentWindow?.postMessage({ type: 'momark-html-frame-source', html }, '*')
}

// 缩放 = CSS zoom + 布局补偿：iframe 视觉盒始终填满容器，内页按比例重排。
// 100% 时不写内联尺寸，iframe 靠 width/height 100% 跟随容器。
const ZOOM_MIN = 0.5
const ZOOM_MAX = 2
const ZOOM_STEP = 1.1
const zoom = ref(1)
const zoomPct = computed(() => `${Math.round(zoom.value * 100)}%`)

const applyZoom = () => {
  const host = hostRef.value
  const frame = frameRef.value
  if (!host || !frame) return
  if (zoom.value === 1) {
    frame.style.zoom = ''
    frame.style.width = ''
    frame.style.height = ''
    return
  }
  frame.style.zoom = `${zoom.value}`
  frame.style.width = `${host.clientWidth / zoom.value}px`
  frame.style.height = `${host.clientHeight / zoom.value}px`
}

const zoomTo = (scale: number) => {
  zoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
  applyZoom()
}
const zoomBy = (factor: number) => zoomTo(zoom.value * factor)

watch(
  () => props.tabId,
  () => {
    zoom.value = 1
  }
)
// 新帧挂上后按当前缩放补一次尺寸（重新载入保留缩放）。
watch(frameKey, async () => {
  await nextTick()
  applyZoom()
})

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  resizeObserver = new ResizeObserver(() => applyZoom())
  if (hostRef.value) resizeObserver.observe(hostRef.value)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

const reload = () => {
  htmlTabsStore.RELOAD(props.tabId)
}
const openExternally = () => {
  if (pathname.value) {
    window.electron.ipcRenderer.send('mt::html::open-externally', pathname.value)
  }
}
const showInFolder = () => {
  if (pathname.value) window.electron.shell.showItemInFolder(pathname.value)
}
</script>

<style scoped>
.html-tab-view {
  position: relative;
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #fff;
}
.html-tab-view iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}
.htv-tools {
  position: absolute;
  right: 20px;
  bottom: 6px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.6);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.html-tab-view:hover .htv-tools {
  opacity: 1;
}
.htv-btn {
  min-width: 24px;
  height: 24px;
  padding: 0 4px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.htv-btn:hover,
.htv-pct:hover {
  background: rgba(255, 255, 255, 0.18);
}
.htv-btn--text {
  padding: 0 6px;
  font-size: 12px;
  white-space: nowrap;
}
.htv-pct {
  min-width: 44px;
  padding: 4px 2px;
  border-radius: 5px;
  color: #fff;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  cursor: pointer;
}
.htv-sep {
  width: 1px;
  height: 14px;
  margin: 0 4px;
  background: rgba(255, 255, 255, 0.3);
}
.htv-turbo {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
  padding: 24px;
  background: var(--bg);
  color: var(--ink);
  text-align: center;
}
.htv-turbo-title {
  font-size: 15px;
  font-weight: 600;
}
.htv-turbo-hint {
  max-width: 360px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}
.htv-turbo-btn {
  margin-top: 4px;
  padding: 6px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
}
.htv-turbo-btn:hover {
  background: var(--hover);
}
</style>
