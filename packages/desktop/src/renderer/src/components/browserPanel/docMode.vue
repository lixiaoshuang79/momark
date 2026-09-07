<template>
  <!-- 原型 .bp-doc：无标题行、无空态提示——有内容渲染 .wysiwyg 等价体，
       空态就是空白画布 + 底部「打开文件…」条。 -->
  <div class="bp-doc">
    <div v-if="hasContent" ref="docBody" v-html="previewHtml" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '@/store/workspace'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { renderMarkdownPreview } from '@/util/browserPanel'

/**
 * 文档模式（PHASE2-SPEC §5）：分屏第二文档 = split.tabId 对应文档的实时预览；
 * 「打开文件…」= docPath 的静态预览。两者都走 引擎 MarkdownToHtml →
 * DOMPurify（FORBID iframe/object/embed/form/input/button），图片相对路径
 * 按文档目录解析。排版完全复刻原型 .wysiwyg（browserPanel.css）。
 *
 * 行进出动画 = 原型 animateDocumentLines/退出公式逐字复刻：
 *   进入 distance=120+min(170,len*1.5)  duration=560+min(360,len*2.8)
 *         delay=index*22+(len%6)*8    --line-x=direction*distance
 *   退出 distance=120+min(150,len*1.35) duration=220+min(120,len*1.3)
 *         delay=index*8+(len%4)*5     --line-out-x=-direction*distance
 *   换文档 = 旧行 line-exit 全部结束后再渲染新行 line-enter；首屏只进不退。
 */

const workspaceStore = useWorkspaceStore()
const bpStore = useBrowserPanelStore()
const { docPath } = storeToRefs(bpStore)
const { splitDocTab } = storeToRefs(workspaceStore)

const previewHtml = ref('')
const pickedMarkdown = ref<{ path: string; markdown: string } | null>(null)
const docBody = ref<HTMLElement | null>(null)

const hasContent = computed(() => !!splitDocTab.value || !!docPath.value)

const docBaseDir = (path: string | null): string => (path ? window.path.dirname(path) : '')

// 渲染令牌：换文档重入时作废旧序列（原型 documentMotionToken 同义）。
let motionToken = 0
let enterTimers: number[] = []

// renderMarkdownPreview 自带 <div class="markdown-body"> 包裹，行动画作用在
// 包裹层内的顶层块元素上（原型 #wysiwyg > * 同构）。
const linesRoot = (): HTMLElement | null => {
  const el = docBody.value
  if (!el) return null
  const inner = el.querySelector<HTMLElement>(':scope > .markdown-body')
  return inner ?? el
}

const animateLinesIn = (direction: number) => {
  const el = linesRoot()
  if (!el) return
  const lines = [...el.children] as HTMLElement[]
  lines.forEach((line, index) => {
    const length = (line.textContent || '').trim().length
    const distance = 120 + Math.min(170, length * 1.5)
    const duration = 560 + Math.min(360, length * 2.8)
    const delay = index * 22 + (length % 6) * 8
    line.classList.remove('line-enter', 'line-exit')
    line.style.setProperty('--line-x', `${direction * distance}px`)
    line.style.setProperty('--line-duration', `${duration}ms`)
    line.style.setProperty('--line-delay', `${delay}ms`)
    // 强制重排后再挂动画类（与原型 void line.offsetWidth 同效）
    line.offsetWidth // eslint-disable-line no-unused-expressions
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
    let outEnd = 0
    lines.forEach((line, index) => {
      const length = (line.textContent || '').trim().length
      const distance = 120 + Math.min(150, length * 1.35)
      const duration = 220 + Math.min(120, length * 1.3)
      const delay = index * 8 + (length % 4) * 5
      outEnd = Math.max(outEnd, duration + delay)
      line.classList.remove('line-enter', 'line-exit')
      line.style.setProperty('--line-out-x', `${-direction * distance}px`)
      line.style.setProperty('--line-out-duration', `${duration}ms`)
      line.style.setProperty('--line-delay', `${delay}ms`)
      line.offsetWidth // eslint-disable-line no-unused-expressions
      line.classList.add('line-exit')
    })
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

// 「打开文件…」由 index.vue 底部条调用：主进程系统对话框 → 读文件 → 预览。
const openFile = async () => {
  const result = await window.bp.pickDoc()
  if (!result) return
  pickedMarkdown.value = result
  bpStore.SET_DOC_PATH(result.path)
}

onBeforeUnmount(() => {
  enterTimers.forEach((t) => window.clearTimeout(t))
  enterTimers = []
})

defineExpose({ openFile })
</script>
