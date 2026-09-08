<template>
  <!-- 原型 .bp-doc：无标题行——有内容渲染 .wysiwyg 等价体；
       空态 = 最近打开列表（点击立即在当前窗口打开为标签）+ 底部「打开文件…」条。 -->
  <div class="bp-doc">
    <div v-if="hasContent" ref="docBody" v-html="previewHtml" />
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '@/store/workspace'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { useEditorStore } from '@/store/editor'
import { useSplitStore } from '@/store/split'
import { renderMarkdownPreview } from '@/util/browserPanel'
import { t } from '../../i18n'

/**
 * 文档模式（PHASE2-SPEC §5）：分屏第二文档 = split.tabId 对应文档的实时预览；
 * 「打开文件…」= 建真实文档标签并进入分屏（keepCurrent：左栏编辑、右栏实时预览）。
 * 排版完全复刻原型 .wysiwyg（browserPanel.css）。
 *
 * 行进出动画 = 原型 animateDocumentLines/退出公式复刻：
 *   进入 distance=120+min(170,len*1.5)  duration=560+min(360,len*2.8)
 *         delay=index*22+(len%6)*8    --line-x=direction*distance
 *   退出 distance=120+min(150,len*1.35) duration=220+min(120,len*1.3)
 *         delay=index*8+(len%4)*5     --line-out-x=-direction*distance
 *   换文档 = 旧行 line-exit 全部结束后再渲染新行 line-enter；首屏只进不退。
 * 规模护栏：块数 > MAX_ANIM_LINES 或 prefers-reduced-motion 时跳过逐行动画
 * （原实现逐行 offsetWidth 强制重排 + 无界 setTimeout 会让大文档卡死主线程）。
 */

const workspaceStore = useWorkspaceStore()
const bpStore = useBrowserPanelStore()
const { docPath } = storeToRefs(bpStore)
const { splitDocTab } = storeToRefs(workspaceStore)

const previewHtml = ref('')
const pickedMarkdown = ref<{ path: string; markdown: string } | null>(null)
const docBody = ref<HTMLElement | null>(null)

const hasContent = computed(() => !!splitDocTab.value || !!docPath.value)

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

const openRecent = (filePath: string) => {
  // 与侧栏文件树一致：当前窗口内打开为标签（不新开窗口）。
  window.electron.ipcRenderer.send('mt::open-file', filePath, {})
}

onMounted(loadRecents)

const docBaseDir = (path: string | null): string => (path ? window.path.dirname(path) : '')

// 渲染令牌：换文档重入时作废旧序列（原型 documentMotionToken 同义）。
let motionToken = 0
let enterTimers: number[] = []

const REDUCED_MOTION =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

// 逐行动画规模护栏：超过即整页瞬时渲染，不做逐行进出动画。
const MAX_ANIM_LINES = 80

// renderMarkdownPreview 自带 <div class="markdown-body"> 包裹，行动画作用在
// 包裹层内的顶层块元素上（原型 #wysiwyg > * 同构）。
const linesRoot = (): HTMLElement | null => {
  const el = docBody.value
  if (!el) return null
  const inner = el.querySelector<HTMLElement>(':scope > .markdown-body')
  return inner ?? el
}

const clearEnterTimers = () => {
  enterTimers.forEach((t) => window.clearTimeout(t))
  enterTimers = []
}

const animateLinesIn = (direction: number) => {
  const el = linesRoot()
  if (!el) return
  const lines = [...el.children] as HTMLElement[]
  if (REDUCED_MOTION || lines.length === 0 || lines.length > MAX_ANIM_LINES) return

  clearEnterTimers()

  // 先写样式（不触发布局）→ 一次读（单次 flush）→ 再挂动画类，避免逐行强制重排。
  const params = lines.map((line, index) => {
    const length = (line.textContent || '').trim().length
    const distance = 120 + Math.min(170, length * 1.5)
    const duration = 560 + Math.min(360, length * 2.8)
    const delay = index * 22 + (length % 6) * 8
    line.classList.remove('line-enter', 'line-exit')
    line.style.setProperty('--line-x', `${direction * distance}px`)
    line.style.setProperty('--line-duration', `${duration}ms`)
    line.style.setProperty('--line-delay', `${delay}ms`)
    return { line, duration, delay }
  })

  // 单次强制重排，样式写完后统一 flush（避免逐行 offsetWidth）
  el.offsetWidth // eslint-disable-line no-unused-expressions

  params.forEach(({ line, duration, delay }) => {
    line.classList.add('line-enter')
    enterTimers.push(
      window.setTimeout(() => line.classList.remove('line-enter'), duration + delay + 80)
    )
  })
}

const animateLinesOut = (direction: number): Promise<void> =>
  new Promise((resolve) => {
    const el = linesRoot()
    if (!el || el.children.length === 0) {
      resolve()
      return
    }
    const lines = [...el.children] as HTMLElement[]
    if (REDUCED_MOTION || lines.length > MAX_ANIM_LINES) {
      resolve()
      return
    }
    let outEnd = 0
    const params = lines.map((line, index) => {
      const length = (line.textContent || '').trim().length
      const distance = 120 + Math.min(150, length * 1.35)
      const duration = 220 + Math.min(120, length * 1.3)
      const delay = index * 8 + (length % 4) * 5
      outEnd = Math.max(outEnd, duration + delay)
      line.classList.remove('line-enter', 'line-exit')
      line.style.setProperty('--line-out-x', `${-direction * distance}px`)
      line.style.setProperty('--line-out-duration', `${duration}ms`)
      line.style.setProperty('--line-delay', `${delay}ms`)
      return { line }
    })
    el.offsetWidth // eslint-disable-line no-unused-expressions
    params.forEach(({ line }) => line.classList.add('line-exit'))
    window.setTimeout(resolve, outEnd + 12)
  })

const renderSplitDoc = async () => {
  const tab = splitDocTab.value
  if (!tab) return
  previewHtml.value = await renderMarkdownPreview(tab.markdown, docBaseDir(tab.pathname))
}

const renderPickedDoc = async (path: string) => {
  const content = pickedMarkdown.value?.path === path ? pickedMarkdown.value.markdown : ''
  previewHtml.value = await renderMarkdownPreview(content, docBaseDir(path))
}

// 等待 v-html 落到 DOM（Vue patch 完成后 children 才存在）。
const waitPatch = async () => {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await new Promise<void>((resolve) => queueMicrotask(resolve))
}

// 换文档：旧行退出动画 → 渲染新内容 → 新行进入动画（方向=1，从右滑入）。
const swapWithMotion = async (render: () => Promise<void>) => {
  const token = ++motionToken
  await animateLinesOut(1)
  if (token !== motionToken) return
  await render()
  if (token !== motionToken) return
  await waitPatch()
  animateLinesIn(1)
}

// 首屏/打开新文件：只进不退（原型 immediate 分支）。
const renderWithMotionIn = async (render: () => Promise<void>) => {
  const token = ++motionToken
  await render()
  if (token !== motionToken) return
  await waitPatch()
  animateLinesIn(1)
}

let lastSplitId: string | undefined | null = null

// 分屏文档实时跟随编辑器内容（贴标高亮/滚动不保留，仅内容同步）；
// 仅「换文档」触发进出动画，打字同步静默重渲染（与原型一致）。
watch(
  () => [splitDocTab.value?.id, splitDocTab.value?.markdown] as const,
  async ([id]) => {
    const tab = splitDocTab.value
    if (!tab) return
    if (id !== lastSplitId) {
      lastSplitId = id
      const hadContent = !!linesRoot() && linesRoot()!.children.length > 0
      if (hadContent) await swapWithMotion(renderSplitDoc)
      else await renderWithMotionIn(renderSplitDoc)
    } else {
      await renderSplitDoc().catch(() => {})
    }
  },
  { immediate: true }
)

watch(
  docPath,
  (path) => {
    if (path) {
      renderWithMotionIn(() => renderPickedDoc(path)).catch(() => {})
    } else {
      previewHtml.value = ''
    }
  },
  { immediate: true }
)

// 「打开文件…」由 index.vue 底部条调用：主进程系统对话框 → 读文件 →
// 建真实文档标签并进入分屏（标签栏/可拖分隔线随之出现；左栏编辑、右栏实时预览）。
const openFile = async () => {
  const result = await window.bp.pickDoc()
  if (!result) return
  const { path, markdown } = result

  const editorStore = useEditorStore()
  const splitStore = useSplitStore()

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
    selected: true
  })

  const tab = editorStore.tabs.find((t) => window.fileUtils.isSamePathSync(t.pathname, path))
  if (tab) {
    bpStore.SET_OPEN(true)
    bpStore.SET_MODE('doc')
    splitStore.DRAG_TO_SPLIT(tab.id, { keepCurrent: true })
  }
}

onBeforeUnmount(() => {
  clearEnterTimers()
})

defineExpose({ openFile })
</script>
