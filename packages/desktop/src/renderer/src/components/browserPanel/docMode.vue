<template>
  <!-- round8：右栏文档从只读预览升级为真 Muya 编辑器（用户拍板：右侧文档
       需可编辑、表格渲染与左侧一致）。分屏文档 = split.tabId 对应文档的
       编辑器实例（docEditorPane）；无分屏 = 最近打开列表（点击直接建标签
       进分屏编辑）+ 底部「打开文件…」条。 -->
  <div class="bp-doc">
    <!-- round11（用户拍板）：右栏不再有任何顶部占位/头条——文档内容开始线
         与左主编辑器对齐由 .bp-inner margin-top 0 + .bp-doc padding-top 0
         保证（两侧 mu-container 同 top）。 -->
    <!-- HTML 渲染页：编辑器内嵌 HTML 块「在侧栏打开」的落点，sandbox 与
         编辑器内嵌同一隔离等级。与分屏 md 文档互斥。关闭走标题栏右侧
         文档名的 ×（直接关掉整个右侧栏，不落空白文档态）。 -->
    <div v-if="htmlDoc" ref="htmlViewRef" class="bp-html-view">
      <iframe
        ref="htmlFrameRef"
        :src="htmlDoc.src"
        sandbox="allow-scripts"
        :title="htmlDoc.title"
        @load="deliverHtmlSource"
      />
      <!-- 缩放控制条（右下角 hover 显示）：− / 100% / +，语义与编辑器
           内嵌 html 块一致——内容缩放（CSS zoom + 布局补偿），视图窗口
           尺寸不变、跟随右侧栏宽度。 -->
      <div class="bp-html-zoom">
        <button class="bp-zoom-btn" type="button" title="Zoom out" @click="zoomBy(1 / 1.1)">
          −
        </button>
        <span class="bp-zoom-pct" title="Reset zoom" @click="zoomTo(1)">{{ zoomPct }}</span>
        <button class="bp-zoom-btn" type="button" title="Zoom in" @click="zoomBy(1.1)">+</button>
      </div>
    </div>
    <doc-editor-pane v-else-if="hasContent" />
    <div v-else class="bp-doc-empty">
      <div class="bp-recents-title">
        {{ t('welcome.recentTitle') }}
      </div>
      <div class="bp-recents">
        <button
          v-for="item in recents"
          :key="item.path"
          class="bp-recent-item"
          :title="item.path"
          @click="openRecent(item.path)"
        >
          <span class="bp-recent-name">{{ item.name }}</span>
          <span class="bp-recent-dir">{{ item.dirname }}</span>
        </button>
        <div v-if="recents.length === 0" class="bp-recents-none">
          {{ t('welcome.noRecentText') }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '@/store/workspace'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { useEditorStore } from '@/store/editor'
import { useSplitStore } from '@/store/split'
import { t } from '../../i18n'
import DocEditorPane from './docEditorPane.vue'

/**
 * 文档模式（PHASE2-SPEC §5，round8 起可编辑）：分屏第二文档 = split.tabId
 * 对应文档的真编辑器；「打开文件…」与最近列表点击 = 建真实文档标签并进入
 * 分屏（keepCurrent：左栏编辑当前文档、右栏编辑分屏文档）。
 */

const workspaceStore = useWorkspaceStore()
const bpStore = useBrowserPanelStore()
const { splitDocTab } = storeToRefs(workspaceStore)
const { htmlDoc } = storeToRefs(bpStore)

const hasContent = computed(() => !!splitDocTab.value)

// ── HTML 渲染页缩放（语义与编辑器内嵌 html 块一致）──────────────────
// CSS zoom（内容缩放，Chrome 页面缩放语义）+ 布局补偿：iframe 视觉盒保持
// 容器尺寸（跟随右侧栏宽度），内页按缩放比例重排放大。50%–200% 几何递进；
// 100% 时不写内联尺寸，iframe 保持 width/height 100% 跟随面板。
const htmlViewRef = ref<HTMLDivElement | null>(null)

// 引导页解析完自己的脚本后才挂上消息监听，因此等 iframe load 再投递源码——与
// 编辑器内嵌块（muya htmlPreview）用的是同一套协议同一份引导页。内容被
// document.write 重写会再触发一次 load，引导页自身有 written 标志，重复投递无害。
const deliverHtmlSource = () => {
  const frame = htmlFrameRef.value
  const html = htmlDoc.value?.html
  if (!frame || !html) return
  frame.contentWindow?.postMessage({ type: 'momark-html-frame-source', html }, '*')
}
const htmlFrameRef = ref<HTMLIFrameElement | null>(null)
const htmlZoom = ref(1)
const ZOOM_MIN = 0.5
const ZOOM_MAX = 2

const zoomPct = computed(() => `${Math.round(htmlZoom.value * 100)}%`)

const applyZoom = () => {
  const host = htmlViewRef.value
  const frame = htmlFrameRef.value
  if (!host || !frame) return
  if (htmlZoom.value === 1) {
    frame.style.zoom = ''
    frame.style.width = ''
    frame.style.height = ''
    return
  }
  const w = host.clientWidth
  const h = host.clientHeight
  frame.style.zoom = `${htmlZoom.value}`
  frame.style.width = `${w / htmlZoom.value}px`
  frame.style.height = `${h / htmlZoom.value}px`
}

const zoomBy = (factor: number) => {
  htmlZoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, htmlZoom.value * factor))
  applyZoom()
}

const zoomTo = (scale: number) => {
  if (!Number.isFinite(scale)) return
  htmlZoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
  applyZoom()
}

// 缩放后拖动右侧栏分隔线：容器尺寸变化时按新尺寸重算补偿（zoom=1 时
// 无内联样式，天然跟随）。换文档/关闭时复位缩放。
let resizeObserver: ResizeObserver | null = null
watch(
  () => htmlDoc.value,
  async (doc) => {
    htmlZoom.value = 1
    resizeObserver?.disconnect()
    resizeObserver = null
    if (!doc) return
    await nextTick()
    applyZoom()
    resizeObserver = new ResizeObserver(() => applyZoom())
    if (htmlViewRef.value) resizeObserver.observe(htmlViewRef.value)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// 空态最近打开列表：主进程系统级最近文档（同欢迎页数据源，≤8 条）。
type RecentItem = { path: string; name: string; dirname: string; mtime: number }
const recents = ref<RecentItem[]>([])

const loadRecents = async () => {
  try {
    recents.value = (await window.electron.ipcRenderer.invoke(
      'mt::welcome::recents'
    )) as RecentItem[]
  } catch {
    recents.value = []
  }
}

onMounted(loadRecents)

// 建真实文档标签并进入分屏（左栏保持当前文档，右栏编辑新文档）。
// round10（用户拍板）：文件已打开也允许进分屏——同一文档左右同开、
// 任一侧编辑另一侧实时同步（allowSame）。
const openFileByPath = async (path: string, markdown: string) => {
  const editorStore = useEditorStore()
  const splitStore = useSplitStore()

  // 打开/新建文档时清掉 HTML 渲染页（两种内容互斥）。
  bpStore.CLOSE_HTML_DOC()

  // 文件已在标签集合：直接进分屏。若该文档已在右屏（分屏中），
  // 左栏也切到它，实现左右同文档双开。
  const existing = editorStore.tabs.find((t) => window.fileUtils.isSamePathSync(t.pathname, path))
  if (existing) {
    bpStore.SET_OPEN(true)
    bpStore.SET_MODE('doc')
    if (splitStore.active && splitStore.tabId === existing.id) {
      editorStore.UPDATE_CURRENT_FILE(existing)
    } else {
      splitStore.DRAG_TO_SPLIT(existing.id, { allowSame: true })
    }
    return
  }

  // 记住打开前的当前文档；全局无当前文档时才让新标签激活（左栏空态）。
  const prev = editorStore.currentFile
  editorStore.NEW_TAB_WITH_CONTENT({
    markdownDocument: {
      markdown,
      filename: window.path.basename(path),
      pathname: path,
      encoding: 'utf8',
      lineEnding: 'lf',
      adjustLineEndingOnSave: true,
      trimTrailingNewline: false,
      isMixedLineEndings: false
    } as never,
    selected: prev == null
  })

  const tab = editorStore.tabs.find((t) => window.fileUtils.isSamePathSync(t.pathname, path))
  if (!tab) return

  bpStore.SET_OPEN(true)
  bpStore.SET_MODE('doc')
  splitStore.DRAG_TO_SPLIT(tab.id, { keepCurrent: prev != null })
}

// 最近文件点击：直接打开进入分屏编辑（round8 起不再只读预览）。
const openRecent = async (filePath: string) => {
  try {
    const result = (await window.bp.readDoc(filePath)) as {
      path: string
      markdown: string
    } | null
    if (result) {
      await openFileByPath(result.path, result.markdown ?? '')
    }
  } catch {
    // 读取失败保持空态。
  }
}

// 「打开文件…」由 index.vue 底部条调用：主进程系统对话框 → 读文件 → 建标签进分屏。
const openFile = async () => {
  const result = await window.bp.pickDoc()
  if (!result) return
  await openFileByPath(result.path, result.markdown ?? '')
}

// 「新建文件」由 index.vue 底部条调用：新建未落盘 untitled 标签并直接
// 进入右栏分屏编辑（左栏保持当前文档）；保存时走主 store 的「另存为」
// 对话框选择落盘路径（与左编辑器新建文档同一管线）。
const newFile = () => {
  const editorStore = useEditorStore()
  const splitStore = useSplitStore()

  bpStore.CLOSE_HTML_DOC()
  editorStore.NEW_UNTITLED_TAB({ selected: false })
  const tab = editorStore.tabs[editorStore.tabs.length - 1]
  if (!tab || tab.pathname !== '') return

  bpStore.SET_OPEN(true)
  bpStore.SET_MODE('doc')
  splitStore.DRAG_TO_SPLIT(tab.id, { keepCurrent: true })
}

defineExpose({ openFile, newFile })
</script>
