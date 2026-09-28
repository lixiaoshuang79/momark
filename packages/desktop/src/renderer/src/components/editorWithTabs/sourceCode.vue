<template>
  <div ref="sourceCodeContainer" class="source-code" />
</template>

<script setup lang="ts">
import { ref, markRaw, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useEditorStore } from '@/store/editor'
import { usePreferencesStore } from '@/store/preferences'
import { findMarkdownHeadingLine, scrollSourceEditorToLine } from '@/util/sourceModeToc'
import { storeToRefs } from 'pinia'
import codeMirror, { setCursorAtFirstLine, setTextDirection } from '../../codeMirror'
import { wordCount as getWordCount } from '@muyajs/core'
import { adjustCursor } from '../../util'
import bus from '../../bus'
import { oneDarkThemes, railscastsThemes } from '@/config'

// CodeMirror 5 ships no first-party types; the wrapper in src/renderer/src/
// codeMirror/index.ts also keeps the surface intentionally loose.
type CMInstance = any
type CMCursor = any

interface MuyaIndexCursorLike {
  anchor: CMCursor
  focus: CMCursor
}

const props = defineProps<{
  markdown?: string
  muyaIndexCursor?: unknown
  textDirection: string
}>()

const editorStore = useEditorStore()
const preferencesStore = usePreferencesStore()

// P2（按键路径）：源码模式的提交原来挂在 `cursorActivity` 上同步做——**纯光标
// 移动**（点击/方向键）也会整篇 `getValue()` + 重算字数 + 走一遍 store 的内容
// 变更管线，大文档上每次点击都白烧一遍；`commitTimer` 只是声明了、从来没排过
// 定时器，防抖形同虚设。现在：内容变更与光标移动分开对待——`change` 置位，提交时
// 才知道要不要整篇读；光标移动只更新光标（复用上次的 markdown / 字数），并且合并
// 到一个 300ms 防抖窗口里。保存/关标签/关窗读 `tab.markdown` 之前会发
// `flush-active-editor`（见 store `flushActiveEditor`），这里同步补交，防抖窗口内
// 的输入不会漏在保存之外。
const COMMIT_DEBOUNCE_MS = 300

const sourceCodeContainer = ref<HTMLDivElement | null>(null)

const editor = ref<CMInstance>(null)
const commitTimer = ref<ReturnType<typeof setTimeout> | null>(null)
const viewDestroyed = ref(false)
const tabId = ref<string | null>(null)

// 自上次提交以来文档是否变过（CodeMirror `change` 置位）。为 false 的提交走
// 「只更新光标」的轻量分支。
let contentDirty = false
// 上次提交出去的 markdown / 字数：文档没变时直接复用，不再整篇读一遍、不再重算。
let committedMarkdown = ''
let committedWordCount: ReturnType<typeof getWordCount> | undefined

const { theme, sourceCode } = storeToRefs(preferencesStore)
const { currentFile: currentTab } = storeToRefs(editorStore)

const isValidMuyaIndexCursor = (cursor: unknown): cursor is MuyaIndexCursorLike => {
  const c = cursor as MuyaIndexCursorLike | null | undefined
  return !!(c && c.anchor && c.focus)
}

watch(
  () => props.textDirection,
  (value, oldValue) => {
    if (value !== oldValue && editor.value) {
      setTextDirection(editor.value, value)
    }
  }
)

// Muya 形态的光标（只读选区端点所在行，成本与文档大小无关）。
const getMuyaCursor = (cm: CMInstance) => {
  let focus = cm.getCursor('head')
  let anchor = cm.getCursor('anchor')

  const convertToMuyaCursor = (cursor: CMCursor) => {
    const line = cm.getLine(cursor.line)
    const preLine = cm.getLine(cursor.line - 1)
    const nextLine = cm.getLine(cursor.line + 1)
    return adjustCursor(
      cursor,
      preLine,
      line,
      nextLine,
      (lineNumber) => {
        return cm.getLine(lineNumber)
      },
      cm.lineCount()
    )
  }

  anchor = convertToMuyaCursor(anchor) // Selection start as Muya cursor
  focus = convertToMuyaCursor(focus) // Selection end as Muya cursor

  // Normalize cursor that `anchor` is always before `focus` because
  // this is the expected behavior in Muya.
  if (anchor && focus && anchor.line > focus.line) {
    const tmpCursor = focus
    focus = anchor
    anchor = tmpCursor
  }
  return { focus, anchor }
}

const getMarkdownAndCursor = (cm: CMInstance) => {
  return { cursor: getMuyaCursor(cm), markdown: cm.getValue() }
}

/**
 * This is to write the OLD content of the editor before switching to another tab
 * @param id
 */
const prepareTabSwitch = () => {
  if (commitTimer.value) {
    clearTimeout(commitTimer.value)
    commitTimer.value = null
  }
  if (tabId.value) {
    const { cursor, markdown: newMarkdown } = getMarkdownAndCursor(editor.value)
    committedMarkdown = newMarkdown
    contentDirty = false
    editorStore.LISTEN_FOR_CONTENT_CHANGE({
      id: tabId.value,
      markdown: newMarkdown,
      muyaIndexCursor: cursor
    })
    tabId.value = null
  }
}

interface FileChangePayloadLike {
  id: string
  markdown?: string
  muyaIndexCursor?: unknown
}

const handleFileChange = (payload: unknown) => {
  const { id, markdown: newMarkdown, muyaIndexCursor } = payload as FileChangePayloadLike
  if (!editor.value) return

  // On same-tab reload (external file change), preserve scroll across
  // setValue. Snapshot every plausible scroll element (the outer
  // .source-code div, CodeMirror's own scroller, and the nearest scrollable
  // ancestor) and restore each, since which one is actually active depends
  // on CodeMirror's height:auto + outer overflow:auto interplay. Re-apply
  // on nextTick and the next animation frame to outlast layout side-effects
  // from sibling handlers: muya editor.vue also listens for file-changed.
  // A cross-tab switch must instead commit the outgoing tab's state; the
  // fresh markdown from disk would otherwise overwrite uncommitted edits.
  const isSameTabReload = tabId.value && tabId.value === id
  const scrollTargets: Array<{ el: HTMLElement; top: number }> = []
  if (isSameTabReload) {
    const seen = new Set<HTMLElement>()
    const consider = (el: HTMLElement | null | undefined) => {
      if (el && !seen.has(el)) {
        seen.add(el)
        scrollTargets.push({ el, top: el.scrollTop })
      }
    }
    consider(sourceCodeContainer.value)
    consider(editor.value.getScrollerElement?.() as HTMLElement | null | undefined)
    let node: HTMLElement | null = sourceCodeContainer.value?.parentElement ?? null
    while (node && node !== document.body) {
      const overflowY = window.getComputedStyle(node).overflowY
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight
      ) {
        consider(node)
        break
      }
      node = node.parentElement
    }
  } else {
    prepareTabSwitch()
    tabId.value = id
  }

  if (typeof newMarkdown === 'string') {
    editor.value.setValue(newMarkdown)
  }

  // t('editor.sourceCode.cursorNullComment')
  if (isValidMuyaIndexCursor(muyaIndexCursor)) {
    const { anchor, focus } = muyaIndexCursor

    editor.value.setSelection(anchor, focus, { scroll: true }) // Scroll the focus into view.
  } else if (scrollTargets.length) {
    const restoreScroll = () => {
      for (const { el, top } of scrollTargets) el.scrollTop = top
    }
    restoreScroll()
    nextTick(restoreScroll)
    requestAnimationFrame(restoreScroll)
  } else {
    setCursorAtFirstLine(editor.value)
  }
}

const handleInvalidateImageCache = () => {
  if (editor.value) {
    editor.value.invalidateImageCache()
  }
}

const handleSelectAll = () => {
  if (!sourceCode.value) {
    return
  }

  if (editor.value && editor.value.hasFocus()) {
    editor.value.execCommand('selectAll')
  } else {
    const activeElement = document.activeElement as HTMLElement | null
    const nodeName = activeElement?.nodeName
    if (nodeName === 'INPUT' || nodeName === 'TEXTAREA') {
      const selectable = activeElement as HTMLInputElement | HTMLTextAreaElement | null
      if (selectable && typeof selectable.select === 'function') {
        selectable.select()
      }
    }
  }
}

const handleUndo = () => {
  if (!sourceCode.value) {
    return
  }

  if (editor.value) {
    editor.value.execCommand('undo')
  }
}

const handleRedo = () => {
  if (!sourceCode.value) {
    return
  }

  if (editor.value) {
    editor.value.execCommand('redo')
  }
}

interface ImageActionPayload {
  id: string
  result: string
  alt: string
}

const handleImageAction = (payload: unknown) => {
  const { id, result, alt } = payload as ImageActionPayload
  const value: string = editor.value.getValue()
  const focus = editor.value.getCursor('focus')
  const anchor = editor.value.getCursor('anchor')
  const lines: string[] = value.split('\n')
  const index = lines.findIndex((line: string) => line.indexOf(id) > 0)

  if (index > -1) {
    const oldLine = lines[index]
    lines[index] = oldLine.replace(new RegExp(`!\\[${id}\\]\\(.*\\)`), `![${alt}](${result})`)
    const newValue = lines.join('\n')
    editor.value.setValue(newValue)
    const match = /(!\[.*\]\(.*\))/.exec(oldLine)
    if (!match) {
      // t('editor.sourceCode.imageStructureDeletedComment')
      return
    }
    const range = {
      start: match.index,
      end: match.index + match[1].length
    }
    const delta = alt.length + result.length + 5 - match[1].length

    const adjustPointer = (pointer: CMCursor) => {
      if (!pointer) {
        return
      }
      if (pointer.line !== index) {
        return
      }
      if (pointer.ch <= range.start) {
        // do nothing.
      } else if (pointer.ch > range.start && pointer.ch < range.end) {
        pointer.ch = range.start + alt.length + result.length + 5
      } else {
        pointer.ch += delta
      }
    }

    adjustPointer(focus)
    adjustPointer(anchor)
    if (focus && anchor) {
      editor.value.setSelection(anchor, focus, { scroll: true })
    } else {
      setCursorAtFirstLine(editor.value)
    }
  }
}

const saveContent = (cm: CMInstance) => {
  if (viewDestroyed.value) return
  if (!tabId.value) {
    // This may occur during tab switching but should not occur otherwise.
    console.warn('LISTEN_FOR_CONTENT_CHANGE: Cannot commit changes because not tab id was set!')
    return
  }

  // 内容没变（纯光标移动）→ 复用上次提交的 markdown / 字数，不整篇读、不重算。
  const needsContentRead = contentDirty
  let markdown = committedMarkdown
  let wordCount = committedWordCount
  if (needsContentRead) {
    const { markdown: freshMarkdown } = getMarkdownAndCursor(cm)
    // Attention: the cursor may be `{focus: null, anchor: null}` when press `backspace`
    markdown = freshMarkdown
    wordCount = getWordCount(freshMarkdown)
    committedMarkdown = freshMarkdown
    committedWordCount = wordCount
    contentDirty = false
  }

  editorStore.LISTEN_FOR_CONTENT_CHANGE({
    id: tabId.value,
    markdown,
    wordCount,
    muyaIndexCursor: getMuyaCursor(cm)
  })
}

// 提交 = 一次 store 内容变更管线（脏标记/自动保存/字数/目录），所以合并到防抖窗口
// 里跑，而不是每个光标事件跑一次。
const scheduleCommit = () => {
  if (viewDestroyed.value) return
  if (commitTimer.value) clearTimeout(commitTimer.value)
  commitTimer.value = setTimeout(() => {
    commitTimer.value = null
    if (editor.value) saveContent(editor.value)
  }, COMMIT_DEBOUNCE_MS)
}

// 保存/关标签/关窗读 `tab.markdown` 之前同步补交（`flush-active-editor` 由 store
// 在这些路径上发出，与左编辑器、右栏 docEditorPane 同款）。强制读一次全文：
// 调用方要的就是「此刻编辑器里的内容」。
const handleFlushActiveEditor = () => {
  if (viewDestroyed.value) return
  if (commitTimer.value) {
    clearTimeout(commitTimer.value)
    commitTimer.value = null
  }
  contentDirty = true
  if (editor.value) saveContent(editor.value)
}

const listenChange = () => {
  // 文档内容变更（打字 / 撤销重做 / setValue / 插图）置位，提交时才决定要不要
  // 整篇读；光标移动只让光标走轻量分支。
  editor.value.on('change', () => {
    contentDirty = true
    scheduleCommit()
  })
  editor.value.on('cursorActivity', () => {
    scheduleCommit()
  })
}

// #3580: in Source Code mode the WYSIWYG container is hidden, so the
// `scroll-to-header` bus event (emitted when a TOC entry is clicked) must scroll
// CodeMirror instead. Resolve the TOC entry to its heading line in the source.
const handleScrollToHeader = (slug: unknown) => {
  if (!editor.value) return
  const index = editorStore.listToc.findIndex((item) => item.slug === slug)
  if (index < 0) return
  const line = findMarkdownHeadingLine(editor.value.getValue(), index)
  if (line < 0) return
  // `.source-code` is the scroll container (CodeMirror renders full-height with
  // viewportMargin: Infinity, so its own scroller never scrolls).
  scrollSourceEditorToLine(editor.value, line, sourceCodeContainer.value)
}

onMounted(() => {
  if (!currentTab.value) return
  const { id } = currentTab.value
  // reset currentTab scrollTop position because the codeMirror scroll position is completely different from the muya scroll position
  // reset cursor because this is a direct "key-cursor", not a muyaIndexCursor, which is {focus: number, anchor: number}
  currentTab.value.scrollTop = 0
  currentTab.value.cursor = undefined

  const { markdown, muyaIndexCursor, textDirection } = props
  // 初始内容就是 CodeMirror 的初始内容：缓存起来，纯光标移动的首次提交可以直接复用。
  committedMarkdown = markdown ?? ''
  committedWordCount = getWordCount(committedMarkdown)
  contentDirty = false
  const container = sourceCodeContainer.value
  const codeMirrorConfig: Record<string, unknown> = {
    value: markdown,
    lineNumbers: true,
    autofocus: true,
    lineWrapping: true,
    styleActiveLine: true,
    direction: textDirection,
    viewportMargin: Infinity,
    lineNumberFormatter(line: number) {
      if (line % 10 === 0 || line === 1) {
        return line
      } else {
        return ''
      }
    }
  }

  if (railscastsThemes.includes(theme.value)) {
    codeMirrorConfig.theme = 'railscasts'
  } else if (oneDarkThemes.includes(theme.value)) {
    codeMirrorConfig.theme = 'one-dark'
  }

  bus.on('file-loaded', handleFileChange)
  bus.on('invalidate-image-cache', handleInvalidateImageCache)
  bus.on('file-changed', handleFileChange)
  bus.on('selectAll', handleSelectAll)
  bus.on('undo', handleUndo)
  bus.on('redo', handleRedo)
  bus.on('image-action', handleImageAction)
  bus.on('scroll-to-header', handleScrollToHeader)
  bus.on('flush-active-editor', handleFlushActiveEditor)

  // CodeMirror's line tree relies on object identity and must not be proxied by Vue.
  const codeMirrorInstance = markRaw(codeMirror(container, codeMirrorConfig))

  // `markdown-math` wraps the standard Markdown mode and delegates `$...$` and
  // `$$...$$` spans to stex so subscript underscores in math do not flip the
  // outer mode into emphasis. See src/renderer/src/codeMirror/markdownMathMode.js.
  codeMirrorInstance.setOption('mode', 'markdown-math')

  codeMirrorInstance.on('contextmenu', (_cm: CMInstance, event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  if (isValidMuyaIndexCursor(muyaIndexCursor)) {
    const { anchor, focus } = muyaIndexCursor
    codeMirrorInstance.setSelection(anchor, focus, { scroll: true })
  } else {
    setCursorAtFirstLine(codeMirrorInstance)
  }

  editor.value = codeMirrorInstance
  tabId.value = id

  listenChange()
})

onBeforeUnmount(() => {
  viewDestroyed.value = true
  if (commitTimer.value) {
    clearTimeout(commitTimer.value)
    commitTimer.value = null
  }

  bus.off('file-loaded', handleFileChange)
  bus.off('invalidate-image-cache', handleInvalidateImageCache)
  bus.off('file-changed', handleFileChange)
  bus.off('selectAll', handleSelectAll)
  bus.off('undo', handleUndo)
  bus.off('redo', handleRedo)
  bus.off('image-action', handleImageAction)
  bus.off('scroll-to-header', handleScrollToHeader)
  bus.off('flush-active-editor', handleFlushActiveEditor)

  const { cursor, markdown: newMarkdown } = getMarkdownAndCursor(editor.value)
  bus.emit('file-changed', {
    id: tabId.value,
    markdown: newMarkdown,
    muyaIndexCursor: cursor,
    renderCursor: true
  })
})
</script>

<style>
.source-code {
  /* 高度由 editor-with-tabs 的 flex 容器限定（chrome 改造后上下新增标签栏/面包屑/状态栏） */
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
}
.source-code .CodeMirror {
  height: auto;
  margin: 50px auto;
  max-width: var(--editorAreaWidth);
  background: transparent;
}
.source-code .CodeMirror-gutters {
  border-right: none;
  background-color: transparent;
}
.source-code .CodeMirror-activeline-background,
.source-code .CodeMirror-activeline-gutter {
  background: var(--floatHoverColor);
}
</style>
