<template>
  <!-- round8：右栏分屏文档 = 真 Muya 编辑器（用户拍板：右侧文档需可编辑、
       表格渲染与左侧一致）。宿主复用 class="editor-component"，claude-editor.css
       的 .mu-container 排版/表格/字体样式全部自动生效，与主编辑器逐像素一致。 -->
  <div class="bp-doc-editor">
    <div ref="hostRef" class="editor-component" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, markRaw } from 'vue'
import { storeToRefs } from 'pinia'
import { Muya, wordCount as muyaWordCount, en, zhCN, type ILocale } from '@muyajs/core'
import { usePreferencesStore } from '@/store/preferences'
import { useEditorStore } from '@/store/editor'
import { useWorkspaceStore } from '@/store/workspace'
import { useSplitStore } from '@/store/split'
import { DEFAULT_EDITOR_FONT_FAMILY, DEFAULT_CODE_FONT_FAMILY } from '@/config'
import { guessClipboardFilePath } from '@/util/clipboard'
import { createImageAction } from '@/util/docPaneImage'
import bus from '@/bus'

/**
 * 右栏分屏文档编辑器：
 * - 与主编辑器共享 @muyajs/core 引擎与全局插件（editor.vue 已在进程内注册）；
 * - 绑定 split.tabId 的文档；json-change → LISTEN_FOR_CONTENT_CHANGE
 *   （自动保存/脏标记/字数统计/TOC 全链路复用主 store 路径）；
 * - 外部内容变化（文件监听等）与换文档 → setContent 回填（不产生 json-change，
 *   无回环风险）；右栏自身编辑产出的 markdown 与 store 一致时跳过回填。
 */

const MUYA_LOCALES: Record<string, ILocale> = { en, 'zh-CN': zhCN }
const getMuyaLocale = (lang: string): ILocale => MUYA_LOCALES[lang] ?? en
const resolveEditorFont = (family: string): string =>
  family ? `${family}, ${DEFAULT_EDITOR_FONT_FAMILY}` : DEFAULT_EDITOR_FONT_FAMILY
const resolveCodeFont = (family: string): string => `${family}, ${DEFAULT_CODE_FONT_FAMILY}`

const hostRef = ref<HTMLElement | null>(null)
const preferencesStore = usePreferencesStore()
const editorStore = useEditorStore()
const workspaceStore = useWorkspaceStore()
const splitStore = useSplitStore()
const { splitDocTab } = storeToRefs(workspaceStore)

const {
  fontSize,
  lineHeight,
  editorFontFamily,
  codeFontFamily,
  codeFontSize,
  tabSize,
  bulletListMarker,
  orderListDelimiter,
  preferLooseListItem,
  autoPairBracket,
  autoPairMarkdownSyntax,
  autoPairQuote,
  trimUnnecessaryCodeBlockEmptyLines,
  language,
  isHtmlEnabled,
  isGitlabCompatibilityEnabled,
  hideQuickInsertHint,
  hideLinkPopup,
  autoCheck,
  sequenceTheme,
  plantumlServer,
  wrapCodeBlocks,
  codeBlockLineNumbers,
  listIndentation,
  frontmatterType,
  superSubScript,
  footnote,
  theme
} = storeToRefs(preferencesStore)

let muya: any = null

const buildOptions = (): Record<string, unknown> => {
  const tab = splitDocTab.value
  const options: Record<string, unknown> = {
    markdown: tab?.markdown ?? '',
    locale: getMuyaLocale(language.value),
    fontSize: fontSize.value,
    lineHeight: lineHeight.value,
    editorFontFamily: resolveEditorFont(editorFontFamily.value),
    codeFontSize: codeFontSize.value,
    codeFontFamily: resolveCodeFont(codeFontFamily.value),
    tabSize: tabSize.value,
    bulletListMarker: bulletListMarker.value,
    orderListDelimiter: orderListDelimiter.value,
    preferLooseListItem: preferLooseListItem.value,
    autoPairBracket: autoPairBracket.value,
    autoPairMarkdownSyntax: autoPairMarkdownSyntax.value,
    autoPairQuote: autoPairQuote.value,
    trimUnnecessaryCodeBlockEmptyLines: trimUnnecessaryCodeBlockEmptyLines.value,
    disableHtml: !isHtmlEnabled.value,
    isGitlabCompatibilityEnabled: isGitlabCompatibilityEnabled.value,
    hideQuickInsertHint: hideQuickInsertHint.value,
    hideLinkPopup: hideLinkPopup.value,
    autoCheck: autoCheck.value,
    sequenceTheme: sequenceTheme.value,
    plantumlServer: plantumlServer.value,
    spellcheckEnabled: false,
    wrapCodeBlocks: wrapCodeBlocks.value,
    codeBlockLineNumbers: codeBlockLineNumbers.value,
    listIndentation: listIndentation.value,
    frontmatterType: frontmatterType.value,
    superSubScript: superSubScript.value,
    footnote: footnote.value,
    clipboardFilePath: guessClipboardFilePath,
    clipboardText: () => window.electron.clipboard.readText(),
    imageAction: createImageAction(() => {
      const t = splitDocTab.value
      return t ? { filename: t.filename, pathname: t.pathname } : null
    }),
    getPathForFile: (file: File) => window.electron.webUtils.getPathForFile(file)
  }
  if (/dark/i.test(theme.value)) {
    options.mermaidTheme = 'dark'
    options.vegaTheme = 'dark'
  } else {
    options.mermaidTheme = 'default'
    options.vegaTheme = 'latimes'
  }
  return options
}

const handleLocale = (locale?: unknown) => {
  if (muya) {
    muya.locale(getMuyaLocale(typeof locale === 'string' ? locale : language.value))
  }
}

onMounted(() => {
  const host = hostRef.value
  if (!host || !splitDocTab.value) return

  // markRaw 同主编辑器：引擎持有 live DOM 与 block tree，不能进 Vue 响应式代理。
  muya = markRaw(new Muya(host, buildOptions()))
  muya.init()

  // 引擎每次文档变更都发 json-change；此处派发主 store 的内容变更管线
  // （脏标记/自动保存/字数统计/TOC），id 绑定分屏文档自身。
  muya.on('json-change', () => {
    const tab = splitDocTab.value
    if (!tab || !muya) return
    const markdown = muya.getMarkdown()
    editorStore.LISTEN_FOR_CONTENT_CHANGE({
      id: tab.id,
      markdown,
      wordCount: muyaWordCount(markdown),
      toc: muya.getTOC(),
      blocks: muya.getState()
    })
  })

  // round10：光标落在右编辑器 → 顶栏字数/保存状态切为右文档数据
  // （左侧编辑器 selection-change 会切回）。
  muya.on('selection-change', () => {
    splitStore.SET_DOC_FOCUSED(true)
  })

  bus.on('language-changed', handleLocale)
})

// 外部内容变化回填：文件监听（file-changed）更新 tab.markdown 时同步进右编辑器；
// 右栏自身编辑经 LISTEN_FOR_CONTENT_CHANGE 写回的 markdown 与引擎一致 → 跳过。
watch(
  () => splitDocTab.value?.markdown,
  (md) => {
    if (!muya || md == null) return
    if (md === muya.getMarkdown()) return
    muya.setContent(md)
  }
)

// 换文档强制重载（即使两文档内容恰好相同，也要重建引擎文档树/历史）。
watch(
  () => splitDocTab.value?.id,
  () => {
    const tab = splitDocTab.value
    if (!muya || !tab) return
    muya.setContent(tab.markdown ?? '')
  }
)

// 主题切换：更新图表主题。
watch(
  () => theme.value,
  () => {
    if (!muya) return
    if (/dark/i.test(theme.value)) {
      muya.setOptions({ mermaidTheme: 'dark', vegaTheme: 'dark' })
    } else {
      muya.setOptions({ mermaidTheme: 'default', vegaTheme: 'latimes' })
    }
  }
)

onBeforeUnmount(() => {
  bus.off('language-changed', handleLocale)
  if (muya) {
    muya.destroy()
    muya = null
  }
})
</script>
