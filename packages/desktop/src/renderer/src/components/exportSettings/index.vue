<template>
  <div class="print-settings-dialog">
    <el-dialog
      v-model="showExportSettingsDialog"
      :show-close="false"
      :modal="true"
      custom-class="ag-dialog-table"
      width="560px"
      @close="handleDialogClose"
    >
      <!-- ── 选项态 ─────────────────────────────────────────── -->
      <template v-if="view === 'options'">
        <h3>
          {{ exportType === 'print' ? t('exportSettings.printTitle') : t('exportSettings.title') }}
        </h3>

        <!-- 格式三卡片：PDF / HTML / docx（打印不显示） -->
        <div v-if="exportType !== 'print'" class="format-cards">
          <div
            v-for="fmt of formatCards"
            :key="fmt.value"
            class="format-card"
            :class="{ on: exportType === fmt.value }"
            @click="selectFormat(fmt.value)"
          >
            <div class="fmt-name">
              {{ fmt.name }}
            </div>
            <div class="fmt-desc">
              {{ fmt.desc }}
            </div>
          </div>
        </div>

        <!-- docx 缺 pandoc：inline 警告 + brew 指引 -->
        <div v-if="exportType === 'docx' && !pandocAvailable" class="pandoc-warning">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          <span>{{ t('exportSettings.pandocMissing') }}</span>
        </div>

        <el-tabs v-if="exportType !== 'docx'" v-model="activeName">
          <el-tab-pane :label="t('exportSettings.info.label')" name="info">
            <span class="text">{{ t('exportSettings.info.description') }}</span>
          </el-tab-pane>
          <el-tab-pane :label="t('exportSettings.page.label')" name="page">
            <!-- HTML -->
            <div v-if="!isPrintable">
              <text-box
                :description="t('exportSettings.page.pageTitle')"
                :input="htmlTitle"
                :emit-time="0"
                :on-change="(value: unknown) => onSelectChange('htmlTitle', value)"
              />
            </div>

            <!-- PDF/Print -->
            <div v-if="isPrintable">
              <div v-if="exportType === 'pdf'">
                <cur-select
                  class="page-size-select"
                  :description="t('exportSettings.page.pageSize')"
                  :value="pageSize"
                  :options="pageSizeList"
                  :on-change="(value: unknown) => onSelectChange('pageSize', value)"
                />
                <div v-if="pageSize === 'custom'" class="row">
                  <div>{{ t('exportSettings.page.widthHeight') }}</div>
                  <el-input-number
                    v-model="pageSizeWidth"
                    size="mini"
                    controls-position="right"
                    :min="100"
                  />
                  <el-input-number
                    v-model="pageSizeHeight"
                    size="mini"
                    controls-position="right"
                    :min="100"
                  />
                </div>

                <bool
                  :description="t('exportSettings.page.landscapeOrientation')"
                  :bool="isLandscape"
                  :on-change="(value: unknown) => onSelectChange('isLandscape', value)"
                />
              </div>

              <div class="row">
                <div class="description">
                  {{ t('exportSettings.page.pageMargin') }}
                </div>
                <div>
                  <div class="label">
                    {{ t('exportSettings.page.topBottom') }}
                  </div>
                  <el-input-number
                    v-model="pageMarginTop"
                    size="mini"
                    controls-position="right"
                    :min="0"
                    :max="100"
                  />
                  <el-input-number
                    v-model="pageMarginBottom"
                    size="mini"
                    controls-position="right"
                    :min="0"
                    :max="100"
                  />
                </div>
                <div>
                  <div class="label">
                    {{ t('exportSettings.page.leftRight') }}
                  </div>
                  <el-input-number
                    v-model="pageMarginLeft"
                    size="mini"
                    controls-position="right"
                    :min="0"
                    :max="100"
                  />
                  <el-input-number
                    v-model="pageMarginRight"
                    size="mini"
                    controls-position="right"
                    :min="0"
                    :max="100"
                  />
                </div>
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane :label="t('exportSettings.style.label')" name="style">
            <bool
              :description="t('exportSettings.style.overwriteThemeFont')"
              :bool="fontSettingsOverwrite"
              :on-change="(value: unknown) => onSelectChange('fontSettingsOverwrite', value)"
            />
            <div v-if="fontSettingsOverwrite">
              <font-text-box
                :description="t('exportSettings.style.fontFamily')"
                :value="fontFamily"
                :on-change="(value: unknown) => onSelectChange('fontFamily', value)"
              />
              <range
                :description="t('exportSettings.style.fontSize')"
                :value="fontSize"
                :min="8"
                :max="32"
                unit="px"
                :step="1"
                :on-change="(value: unknown) => onSelectChange('fontSize', value)"
              />
              <range
                :description="t('exportSettings.style.lineHeight')"
                :value="lineHeight"
                :min="1.0"
                :max="2.0"
                :step="0.1"
                :on-change="(value: unknown) => onSelectChange('lineHeight', value)"
              />
            </div>
            <bool
              :description="t('exportSettings.autoNumberingHeadings')"
              :bool="autoNumberingHeadings"
              :on-change="(value: unknown) => onSelectChange('autoNumberingHeadings', value)"
            />
            <bool
              :description="t('exportSettings.showFrontMatter')"
              :bool="showFrontMatter"
              :on-change="(value: unknown) => onSelectChange('showFrontMatter', value)"
            />
          </el-tab-pane>
          <el-tab-pane :label="t('exportSettings.theme.label')" name="theme">
            <div class="text">
              {{ t('exportSettings.theme.description') }}
            </div>
            <cur-select
              :description="t('exportSettings.theme.theme')"
              :value="theme"
              :options="themeList"
              :on-change="(value: unknown) => onSelectChange('theme', value)"
            />
          </el-tab-pane>
          <el-tab-pane
            v-if="isPrintable"
            :label="t('exportSettings.headerFooter.label')"
            name="header"
          >
            <div class="text">
              {{ t('exportSettings.headerFooter.description') }}
            </div>
            <cur-select
              :description="t('exportSettings.headerFooter.headerType')"
              :value="headerType"
              :options="headerFooterTypes"
              :on-change="(value: unknown) => onSelectChange('headerType', value)"
            />
            <text-box
              v-if="headerType === 2"
              :description="t('exportSettings.headerFooter.leftHeaderText')"
              :input="headerTextLeft"
              :emit-time="0"
              :on-change="(value: unknown) => onSelectChange('headerTextLeft', value)"
            />
            <text-box
              v-if="headerType !== 0"
              :description="t('exportSettings.headerFooter.mainHeaderText')"
              :input="headerTextCenter"
              :emit-time="0"
              :on-change="(value: unknown) => onSelectChange('headerTextCenter', value)"
            />
            <text-box
              v-if="headerType === 2"
              :description="t('exportSettings.headerFooter.rightHeaderText')"
              :input="headerTextRight"
              :emit-time="0"
              :on-change="(value: unknown) => onSelectChange('headerTextRight', value)"
            />

            <cur-select
              :description="t('exportSettings.headerFooter.footerType')"
              :value="footerType"
              :options="headerFooterTypes"
              :on-change="(value: unknown) => onSelectChange('footerType', value)"
            />
            <text-box
              v-if="footerType === 2"
              :description="t('exportSettings.headerFooter.leftFooterText')"
              :input="footerTextLeft"
              :emit-time="0"
              :on-change="(value: unknown) => onSelectChange('footerTextLeft', value)"
            />
            <text-box
              v-if="footerType !== 0"
              :description="t('exportSettings.headerFooter.mainFooterText')"
              :input="footerTextCenter"
              :emit-time="0"
              :on-change="(value: unknown) => onSelectChange('footerTextCenter', value)"
            />
            <text-box
              v-if="footerType === 2"
              :description="t('exportSettings.headerFooter.rightFooterText')"
              :input="footerTextRight"
              :emit-time="0"
              :on-change="(value: unknown) => onSelectChange('footerTextRight', value)"
            />

            <bool
              :description="t('exportSettings.headerFooter.customizeStyle')"
              :bool="headerFooterCustomize"
              :on-change="(value: unknown) => onSelectChange('headerFooterCustomize', value)"
            />

            <div v-if="headerFooterCustomize">
              <bool
                :description="t('exportSettings.headerFooter.allowStyled')"
                :bool="headerFooterStyled"
                :on-change="(value: unknown) => onSelectChange('headerFooterStyled', value)"
              />
              <range
                :description="t('exportSettings.headerFooter.fontSize')"
                :value="headerFooterFontSize"
                :min="8"
                :max="20"
                unit="px"
                :step="1"
                :on-change="(value: unknown) => onSelectChange('headerFooterFontSize', value)"
              />
            </div>
          </el-tab-pane>

          <el-tab-pane :label="t('exportSettings.toc.label')" name="toc">
            <bool
              :description="t('exportSettings.toc.includeTopHeading')"
              :detailed-description="t('exportSettings.toc.includeTopHeadingDetail')"
              :bool="tocIncludeTopHeading"
              :on-change="(value: unknown) => onSelectChange('tocIncludeTopHeading', value)"
            />
            <text-box
              :description="t('exportSettings.toc.title')"
              :input="tocTitle"
              :emit-time="0"
              :on-change="(value: unknown) => onSelectChange('tocTitle', value)"
            />
          </el-tab-pane>
        </el-tabs>

        <!-- 打印预览：纸面恒白 + 页眉页脚三格实时联动 -->
        <div v-if="isPrintable && exportType !== 'docx'" class="print-preview">
          <div class="preview-title">
            {{ t('exportSettings.preview') }}
          </div>
          <div class="preview-paper">
            <div v-if="headerType !== 0" class="hf-row">
              <span v-if="headerType === 2" class="cell left">{{
                previewCell(headerTextLeft)
              }}</span>
              <span class="cell center">{{ previewCell(headerTextCenter) }}</span>
              <span v-if="headerType === 2" class="cell right">{{
                previewCell(headerTextRight)
              }}</span>
            </div>
            <div class="fake-body">
              <div class="fake-title" />
              <div class="fake-line w-90" />
              <div class="fake-line w-70" />
              <div class="fake-line w-80" />
            </div>
            <div v-if="footerType !== 0" class="hf-row footer">
              <span v-if="footerType === 2" class="cell left">{{
                previewCell(footerTextLeft)
              }}</span>
              <span class="cell center">{{ previewCell(footerTextCenter) }}</span>
              <span v-if="footerType === 2" class="cell right">{{
                previewCell(footerTextRight)
              }}</span>
            </div>
          </div>
        </div>

        <div class="button-controlls">
          <button class="button-primary" @click="handleClicked">
            {{ exportType === 'print' ? t('exportSettings.print') : t('exportSettings.export') }}
          </button>
        </div>
      </template>

      <!-- ── 进度态：阶段文案 + 百分比 + 取消 ───────────────── -->
      <template v-else-if="view === 'progress'">
        <h3>
          {{ progressTitle }}
        </h3>
        <div class="progress-state">
          <div class="progress-phase">
            {{ progress.phase }}
          </div>
          <el-progress
            v-if="progress.percent != null"
            :percentage="Math.min(100, Math.max(0, Math.round(progress.percent)))"
            :show-text="true"
          />
          <div v-else class="progress-indeterminate" />
        </div>
        <div class="button-controlls">
          <button class="button-default" @click="cancelExport">
            {{ t('exportSettings.cancel') }}
          </button>
        </div>
      </template>

      <!-- ── 完成态：完成 + 在 Finder 中显示 ───────────────── -->
      <template v-else-if="view === 'done'">
        <h3>
          {{ t('exportSettings.exportDone') }}
        </h3>
        <div class="done-state">
          <div class="done-file">
            {{ lastFile }}
          </div>
        </div>
        <div class="button-controlls">
          <button class="button-primary" @click="showInFinder">
            {{ t('exportSettings.showInFinder') }}
          </button>
          <button class="button-default" @click="closeDialog">
            {{ t('exportSettings.done') }}
          </button>
        </div>
      </template>

      <!-- ── 失败态 ────────────────────────────────────────── -->
      <template v-else>
        <h3>
          {{ t('exportSettings.exportFailed') }}
        </h3>
        <div class="failed-state">
          <div class="failed-message">
            {{ failMessage }}
          </div>
        </div>
        <div class="button-controlls">
          <button class="button-default" @click="backToOptions">
            {{ t('exportSettings.retry') }}
          </button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, type Ref } from 'vue'
import bus from '../../bus'
import notice from '../../services/notification'
import { loadExportSettings, saveExportSettings } from './persistence'
import Bool from '@/prefComponents/common/bool/index.vue'
import CurSelect from '@/prefComponents/common/select/index.vue'
import FontTextBox from '@/prefComponents/common/fontTextBox/index.vue'
import Range from '@/prefComponents/common/range/index.vue'
import TextBox from '@/prefComponents/common/textBox/index.vue'
import { getPageSizeList, getHeaderFooterTypes, getExportThemeList } from './exportOptions'
import { t } from '../../i18n'
import { useEditorStore } from '@/store/editor'

const editorStore = useEditorStore()

const exportType = ref('')
const themesLoaded = ref(false)
const isPrintable = ref(true)
const showExportSettingsDialog = ref(false)
const activeName = ref('info')
const htmlTitle = ref('')
const pageSize = ref('A4')
const pageSizeWidth = ref(210)
const pageSizeHeight = ref(297)
const isLandscape = ref(false)
const pageMarginTop = ref(20)
const pageMarginRight = ref(15)
const pageMarginBottom = ref(20)
const pageMarginLeft = ref(15)
const fontSettingsOverwrite = ref(false)
const fontFamily = ref('Default')
const fontSize = ref(14)
const lineHeight = ref(1.5)
const autoNumberingHeadings = ref(false)
const showFrontMatter = ref(false)
const theme = ref('default')
const themeList = ref(getExportThemeList())
const pageSizeList = ref(getPageSizeList())
const headerFooterTypes = ref(getHeaderFooterTypes())
const headerType = ref(0)
const headerTextLeft = ref('')
const headerTextCenter = ref('')
const headerTextRight = ref('')
const footerType = ref(0)
const footerTextLeft = ref('')
const footerTextCenter = ref('')
const footerTextRight = ref('')
const headerFooterCustomize = ref(false)
const headerFooterStyled = ref(true)
const headerFooterFontSize = ref(12)
const tocTitle = ref('')
const tocIncludeTopHeading = ref(true)

// ---- 导出对话框状态机：options → progress → done / failed
type ExportView = 'options' | 'progress' | 'done' | 'failed'
const view = ref<ExportView>('options')
const progress = ref<{ phase: string; percent: number | null }>({ phase: '', percent: null })
const lastFile = ref('')
const failMessage = ref('')
const pandocAvailable = ref(true)

const formatCards = computed(() => [
  { value: 'pdf', name: 'PDF', desc: t('exportSettings.formatPdf') },
  { value: 'styledHtml', name: 'HTML', desc: t('exportSettings.formatHtml') },
  { value: 'docx', name: 'docx', desc: t('exportSettings.formatDocx') }
])

const progressTitle = computed(() => {
  if (exportType.value === 'docx') {
    return t('exportSettings.exportingDocx')
  }
  if (exportType.value === 'pdf') {
    return t('exportSettings.exportingPdf')
  }
  return t('exportSettings.exportingHtml')
})

// #2287 — persist the chosen export options across sessions. Every option ref
// is registered here; changes are saved to localStorage and restored on mount.
const persistableSettings: Record<string, Ref<unknown>> = {
  htmlTitle,
  pageSize,
  pageSizeWidth,
  pageSizeHeight,
  isLandscape,
  pageMarginTop,
  pageMarginRight,
  pageMarginBottom,
  pageMarginLeft,
  fontSettingsOverwrite,
  fontFamily,
  fontSize,
  lineHeight,
  autoNumberingHeadings,
  showFrontMatter,
  theme,
  headerType,
  headerTextLeft,
  headerTextCenter,
  headerTextRight,
  footerType,
  footerTextLeft,
  footerTextCenter,
  footerTextRight,
  headerFooterCustomize,
  headerFooterStyled,
  headerFooterFontSize,
  tocTitle,
  tocIncludeTopHeading
}

const restoreExportSettings = () => {
  const saved = loadExportSettings()
  for (const [key, settingRef] of Object.entries(persistableSettings)) {
    if (key in saved) settingRef.value = saved[key]
  }
}

watch(Object.values(persistableSettings), () => {
  saveExportSettings(
    Object.fromEntries(
      Object.entries(persistableSettings).map(([key, settingRef]) => [key, settingRef.value])
    )
  )
})

// ---- 页眉/页脚预览占位符替换：{page} → 页码示意，{date} → 今天日期
const previewCell = (text: string): string => {
  const date = new Date().toLocaleDateString()
  return text.replace(/\{page\}/g, '1').replace(/\{date\}/g, date)
}

const formatDateForExport = (): string => new Date().toLocaleDateString()

const checkPandoc = (): void => {
  const probe = (): Promise<boolean> => {
    try {
      if (typeof window.commandExists?.exists === 'function') {
        return window.commandExists.exists('pandoc')
      }
      return window.electron.ipcRenderer.invoke('mt::cmd::exists', 'pandoc')
    } catch {
      return Promise.resolve(true)
    }
  }
  probe()
    .then((available: boolean) => {
      pandocAvailable.value = available
    })
    .catch(() => {
      pandocAvailable.value = true
    })
}

const selectFormat = (type: string): void => {
  exportType.value = type
  isPrintable.value = type !== 'styledHtml'
  if (type === 'docx') {
    checkPandoc()
    activeName.value = 'info'
  } else if (!isPrintable.value && (activeName.value === 'header' || activeName.value === 'page')) {
    activeName.value = 'info'
  }
}

const showDialog = (type: unknown) => {
  const exportTypeValue = String(type ?? '')
  view.value = 'options'
  progress.value = { phase: '', percent: null }
  exportType.value = exportTypeValue
  isPrintable.value = exportTypeValue !== 'styledHtml'
  if (!isPrintable.value && (activeName.value === 'header' || activeName.value === 'page')) {
    activeName.value = 'info'
  }
  if (exportTypeValue === 'docx') {
    activeName.value = 'info'
    checkPandoc()
  }

  // 打印：页眉页脚默认三格（左文档名 / 中页码 / 右日期），用户未配置时才注入。
  if (
    exportTypeValue === 'print' &&
    headerType.value === 0 &&
    footerType.value === 0 &&
    !headerTextLeft.value &&
    !headerTextCenter.value &&
    !headerTextRight.value
  ) {
    headerType.value = 2
    headerTextLeft.value = editorStore.currentFile?.filename ?? t('exportSettings.untitled')
    headerTextCenter.value = '{page}'
    headerTextRight.value = formatDateForExport()
  }

  showExportSettingsDialog.value = true
  bus.emit('editor-blur')

  if (!themesLoaded.value) {
    themesLoaded.value = true
    loadThemesFromDisk()
  }
}

const buildOptions = (): Record<string, unknown> => {
  const options: Record<string, unknown> = {
    type: exportType.value,
    pageSize: pageSize.value,
    pageSizeWidth: pageSizeWidth.value,
    pageSizeHeight: pageSizeHeight.value,
    isLandscape: isLandscape.value,
    pageMarginTop: pageMarginTop.value,
    pageMarginRight: pageMarginRight.value,
    pageMarginBottom: pageMarginBottom.value,
    pageMarginLeft: pageMarginLeft.value,
    autoNumberingHeadings: autoNumberingHeadings.value,
    showFrontMatter: showFrontMatter.value,
    theme: theme.value === 'default' ? null : theme.value,
    tocTitle: tocTitle.value,
    tocIncludeTopHeading: tocIncludeTopHeading.value
  }

  if (!isPrintable.value) {
    options.htmlTitle = htmlTitle.value
  }

  if (fontSettingsOverwrite.value) {
    Object.assign(options, {
      fontSize: fontSize.value,
      lineHeight: lineHeight.value,
      fontFamily: fontFamily.value === 'Default' ? null : fontFamily.value
    })
  }

  // 打印（系统打印面板）路径：把 {date} 展开为今天日期；{page} 交由系统打印
  // 面板的页眉页脚生成，文档内不再渲染字面令牌。
  const substitute = (text: string): string =>
    exportType.value === 'print'
      ? text.replace(/\{date\}/g, formatDateForExport()).replace(/\{page\}/g, '')
      : text

  if (headerType.value !== 0) {
    Object.assign(options, {
      header: {
        type: headerType.value,
        left: substitute(headerTextLeft.value),
        center: substitute(headerTextCenter.value),
        right: substitute(headerTextRight.value)
      }
    })
  }

  if (footerType.value !== 0) {
    Object.assign(options, {
      footer: {
        type: footerType.value,
        left: substitute(footerTextLeft.value),
        center: substitute(footerTextCenter.value),
        right: substitute(footerTextRight.value)
      }
    })
  }

  if (headerFooterCustomize.value) {
    Object.assign(options, {
      headerFooterStyled: headerFooterStyled.value,
      headerFooterFontSize: headerFooterFontSize.value
    })
  }

  return options
}

const handleClicked = () => {
  const options = buildOptions()

  if (exportType.value === 'print') {
    // 打印走系统打印面板：关闭对话框，隐藏容器渲染由 editor.vue 完成。
    showExportSettingsDialog.value = false
    bus.emit('export', options)
    return
  }

  // HTML / PDF / docx：进入进度态，等待主进程推送进度与结果。
  view.value = 'progress'
  progress.value = { phase: t('exportSettings.preparing'), percent: null }
  bus.emit('export', options)
}

const cancelExport = (): void => {
  window.electron.ipcRenderer.send('mt::export-cancel')
  progress.value = { phase: t('exportSettings.canceling'), percent: null }
}

const showInFinder = (): void => {
  if (lastFile.value) {
    window.electron.shell.showItemInFolder(lastFile.value)
  }
}

const closeDialog = (): void => {
  showExportSettingsDialog.value = false
}

const backToOptions = (): void => {
  view.value = 'options'
  progress.value = { phase: '', percent: null }
  failMessage.value = ''
}

const handleDialogClose = (): void => {
  // el-dialog 关闭后重置为选项态，避免残留完成/失败界面。
  view.value = 'options'
  progress.value = { phase: '', percent: null }
  failMessage.value = ''
}

const onExportProgress = (_event: unknown, payload: unknown): void => {
  const p = payload as { phase?: string; percent?: number | null } | undefined
  progress.value = {
    phase: p?.phase ?? progress.value.phase,
    percent: p?.percent ?? null
  }
}

const onExportSuccess = (_event: unknown, payload: unknown): void => {
  const p = payload as { filePath?: string } | undefined
  lastFile.value = p?.filePath ?? ''
  view.value = 'done'
}

const onExportFailure = (_event: unknown, payload: unknown): void => {
  const p = payload as { message?: string; canceled?: boolean } | undefined
  if (p?.canceled) {
    notice.notify({
      title: t('exportSettings.canceledToast'),
      message: '',
      type: 'info',
      time: 2500
    })
    backToOptions()
    return
  }
  failMessage.value = p?.message ?? t('exportSettings.exportFailed')
  view.value = 'failed'
}

const onSelectChange = (key: string, value: unknown) => {
  const state: Record<string, Ref<unknown>> = {
    htmlTitle,
    pageSize,
    isLandscape,
    fontSettingsOverwrite,
    fontFamily,
    fontSize,
    lineHeight,
    autoNumberingHeadings,
    showFrontMatter,
    theme,
    headerType,
    headerTextLeft,
    headerTextCenter,
    headerTextRight,
    footerType,
    footerTextLeft,
    footerTextCenter,
    footerTextRight,
    headerFooterCustomize,
    headerFooterStyled,
    headerFooterFontSize,
    tocIncludeTopHeading,
    tocTitle
  }
  if (key in state) {
    state[key]!.value = value
  }
}

const loadThemesFromDisk = async () => {
  // marktext.paths is attached to `window` at runtime by bootstrap.ts but
  // isn't part of the typed contextBridge surface. Cast through `unknown`.
  const marktext = (window as unknown as { marktext?: { paths?: { userDataPath?: string } } })
    .marktext
  const userDataPath = marktext?.paths?.userDataPath
  if (!userDataPath) return
  const themeDir = window.path.join(userDataPath, 'themes/export')

  if (!(await window.fileUtils.isDirectory(themeDir))) return
  let filenames = []
  try {
    filenames = await window.fileUtils.readdir(themeDir)
  } catch {
    return
  }

  for (const filename of filenames) {
    const fullname = window.path.join(themeDir, filename)
    if (!/.+\.css$/i.test(filename)) continue
    if (!(await window.fileUtils.isFile(fullname))) continue
    try {
      const buf = await window.fileUtils.readFile(fullname)
      const content = buf instanceof Uint8Array ? new TextDecoder('utf-8').decode(buf) : String(buf)
      const match = content.match(/^(?:\/\*+[ \t]*([A-z0-9 -]+)[ \t]*(?:\*+\/|[\n\r])?)/)
      const label = match && match[1] ? match[1] : filename
      themeList.value.push({ value: filename, label })
    } catch (e) {
      console.error('loadThemesFromDisk failed:', e)
    }
  }
}

onMounted(() => {
  restoreExportSettings()
  bus.on('showExportDialog', showDialog)
  bus.on('language-changed', updateTranslations)
  window.electron.ipcRenderer.on('mt::export-progress', onExportProgress)
  window.electron.ipcRenderer.on('mt::export-success', onExportSuccess)
  window.electron.ipcRenderer.on('mt::export-failure', onExportFailure)
})

onBeforeUnmount(() => {
  bus.off('showExportDialog', showDialog)
  bus.off('language-changed', updateTranslations)
  window.electron.ipcRenderer.removeAllListeners('mt::export-progress')
  window.electron.ipcRenderer.removeAllListeners('mt::export-success')
  window.electron.ipcRenderer.removeAllListeners('mt::export-failure')
})

const updateTranslations = () => {
  themeList.value = getExportThemeList()
  pageSizeList.value = getPageSizeList()
  headerFooterTypes.value = getHeaderFooterTypes()
}
</script>

<style scoped>
.print-settings-dialog {
  user-select: none;
}
.row {
  margin-bottom: 8px;
}
.description {
  margin-bottom: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.label {
  margin-bottom: 5px;
}
.label ~ div {
  margin-right: 20px;
}
.text {
  white-space: pre-wrap;
  word-break: break-word;
}

.button-controlls {
  margin-top: 12px;
  text-align: right;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.button-controlls .button-primary {
  font-size: 14px;
}

.button-controlls .button-default {
  font-size: 14px;
}

.el-tab-pane section:first-child {
  margin-top: 0;
}

/* ── 格式三卡片（tokens） ── */
.format-cards {
  display: flex;
  gap: 10px;
  margin: 12px 0 16px;
}

.format-card {
  flex: 1;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 10px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.format-card:hover {
  border-color: var(--line-strong);
}

.format-card.on {
  border-color: var(--accent);
  box-shadow: var(--focus-ring);
}

.format-card .fmt-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.format-card .fmt-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
}

/* ── pandoc inline 警告 ── */
.pandoc-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 14px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink);
  background: color-mix(in oklab, var(--warn), transparent 86%);
  border: 1px solid color-mix(in oklab, var(--warn), transparent 55%);
  border-radius: 8px;
}

.pandoc-warning svg {
  color: var(--warn);
  flex: none;
  margin-top: 1px;
}

/* ── 进度 / 完成 / 失败态 ── */
.progress-state {
  padding: 28px 12px;
}

.progress-phase {
  margin-bottom: 14px;
  font-size: 14px;
  color: var(--ink);
}

.progress-indeterminate {
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--selected);
  position: relative;
}

.progress-indeterminate::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -40%;
  width: 40%;
  border-radius: 3px;
  background: var(--accent);
  animation: progress-slide 1.2s ease-in-out infinite;
}

@keyframes progress-slide {
  0% {
    left: -40%;
  }
  100% {
    left: 100%;
  }
}

.done-state {
  padding: 28px 12px;
  text-align: center;
}

.done-file {
  font-size: 14px;
  color: var(--muted);
  word-break: break-all;
}

.failed-state {
  padding: 28px 12px;
}

.failed-message {
  font-size: 14px;
  line-height: 1.6;
  color: var(--danger);
  word-break: break-word;
}

/* ── 打印预览：纸面恒白（深浅主题一致） ── */
.print-preview {
  margin-top: 14px;
}

.print-preview .preview-title {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}

.preview-paper {
  /* 纸面固定纯白 + 深灰字，不随主题变化 */
  background: #ffffff;
  color: #333333;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px 18px;
  box-shadow: var(--shadow);
}

.preview-paper .hf-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: #6b6b6b;
  border-bottom: 1px solid #e8e8e4;
  padding-bottom: 6px;
}

.preview-paper .hf-row.footer {
  border-bottom: none;
  border-top: 1px solid #e8e8e4;
  padding-top: 6px;
}

.preview-paper .hf-row .cell {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-paper .hf-row .cell.left {
  text-align: left;
}

.preview-paper .hf-row .cell.center {
  text-align: center;
}

.preview-paper .hf-row .cell.right {
  text-align: right;
}

.preview-paper .fake-body {
  padding: 12px 0;
}

.preview-paper .fake-title {
  width: 42%;
  height: 10px;
  border-radius: 5px;
  background: #3d5a80;
  opacity: 0.85;
  margin-bottom: 10px;
}

.preview-paper .fake-line {
  height: 7px;
  border-radius: 4px;
  background: #e9e9e6;
  margin: 6px 0;
}

.preview-paper .fake-line.w-90 {
  width: 90%;
}

.preview-paper .fake-line.w-70 {
  width: 70%;
}

.preview-paper .fake-line.w-80 {
  width: 80%;
}
</style>
<style>
.print-settings-dialog #pane-header .pref-text-box-item .el-input {
  width: 90% !important;
}

.print-settings-dialog .el-dialog__body {
  padding: 0 20px 20px 20px;
}
.print-settings-dialog .pref-select-item .el-select {
  width: 240px;
}
.print-settings-dialog .el-tabs__content {
  max-height: 350px;
  overflow-x: hidden;
  overflow-y: auto;
}

.print-settings-dialog .el-tabs__content::-webkit-scrollbar:vertical {
  width: 5px;
}

.el-input-number {
  & div {
    background: var(--inputBgColor);
  }
  & input {
    border: none !important;
  }
}
</style>
