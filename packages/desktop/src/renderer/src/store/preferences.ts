import { defineStore } from 'pinia'
import bus from '../bus'
import { setLanguage } from '../i18n'

// Finite-value unions where the runtime currently constrains the field.
// We keep these as plain strings everywhere else to avoid forcing prematurely
// narrow casts on consumers that read raw values from disk.
export type EndOfLine = 'default' | 'lf' | 'crlf'
export type TitleBarStyle = 'custom' | 'native'
// F1(P0-1)：`restoreAll`（恢复上次会话）与 `lastSession` 已不再是合法取值——
// 前者对应的恢复链路早已移除，保留它只会让「关窗不提示保存」的豁免条件复活；
// 老用户磁盘上的 `restoreAll` 由主进程在打开偏好文件前迁移为 `blank`
// （见 src/main/preferences/index.ts）。与 main/preferences/schema.json 的 enum 保持一致。
export type StartUpAction = 'folder' | 'openLastFolder' | 'blank'
export type TextDirection = 'ltr' | 'rtl'
export type BulletListMarker = '*' | '+' | '-'
export type OrderListDelimiter = '.' | ')'
export type PreferHeadingStyle = 'atx' | 'setext'
export type FrontmatterType = '-' | ';' | '{' | '+'
export type SequenceTheme = 'hand' | 'simple'
export type ImageInsertAction = 'folder' | 'path' | 'upload'
export type ImageRelativeDirectoryBase = 'file' | 'root'
export type ImageInsertBehavior = 'render' | 'viewer'
export type ImageUploaderService = 'picgo' | 'tencent-cos'
export type FileSortBy = 'created' | 'modified' | 'title'
export type FileSortOrder = 'asc' | 'desc'

/**
 * 常用语（标注卡片 chips）的默认值与上限。三处必须一致：本文件的默认值、
 * `main/preferences/schema.json` 的 default/maxItems/maxLength、
 * `static/preference.json` 的种子——任一处漂移都会让「恢复默认」与首启不一致。
 * 引擎侧同名常量（`packages/muya/src/annotation/quickPhrase.ts`）由 A 线维护，
 * 桌面不跨包 import（两条线并行开发期间互不依赖构建产物）。
 */
export const DEFAULT_QUICK_PHRASES: string[] = ['看不懂，优化表达', '删掉', '写详细', '待定']
export const QUICK_PHRASE_MAX_LEN = 24
export const QUICK_PHRASE_MAX_COUNT = 9

export interface PreferencesState {
  // ----- General -----
  autoSave: boolean
  autoSaveDelay: number
  // 内容标注总开关（feat/annotations）：关 = 隐藏右栏第三 tab、工具条不出标注
  // 按钮、正文不画高亮；已落盘的标注数据保留，重新打开即原样恢复。
  annotationEnabled: boolean
  // 标注卡片的常用语（feat/quick-phrases）：顺序即 ⌥1–⌥9 的键位顺序，
  // 最多 9 条、每条 ≤24 字。应用级一份（不随文档存），`[]` 是合法值。
  annotationQuickPhrases: string[]
  titleBarStyle: TitleBarStyle | string
  openFilesInNewWindow: boolean
  openFolderInNewWindow: boolean
  zoom: number
  hideScrollbar: boolean
  wordWrapInToc: boolean
  fileSortBy: FileSortBy | string
  fileSortOrder: FileSortOrder | string
  startUpAction: StartUpAction | string
  restoreLayoutState: boolean
  defaultDirectoryToOpen: string
  lastOpenedFolder: string
  treePathExcludePatterns: string[]
  language: string

  // ----- Editor / typography -----
  editorFontFamily: string
  fontSize: number
  lineHeight: number
  codeFontSize: number
  codeFontFamily: string
  codeBlockLineNumbers: boolean
  trimUnnecessaryCodeBlockEmptyLines: boolean
  wrapCodeBlocks: boolean
  editorLineWidth: string

  // ----- Markdown editing -----
  autoPairBracket: boolean
  autoPairMarkdownSyntax: boolean
  autoPairQuote: boolean
  endOfLine: EndOfLine | string
  defaultEncoding: string
  autoGuessEncoding: boolean
  autoNormalizeLineEndings: boolean

  trimTrailingNewline: number
  textDirection: TextDirection | string
  hideQuickInsertHint: boolean
  imageInsertAction: ImageInsertAction | string
  imagePreferRelativeDirectory: boolean
  imageRelativeDirectoryBase: ImageRelativeDirectoryBase | string
  imageRelativeDirectoryName: string
  imageInsertBehavior: ImageInsertBehavior | string
  imageUploaderEnabled: boolean
  imageUploaderService: ImageUploaderService | string
  hideLinkPopup: boolean
  autoCheck: boolean

  preferLooseListItem: boolean
  bulletListMarker: BulletListMarker | string
  orderListDelimiter: OrderListDelimiter | string
  preferHeadingStyle: PreferHeadingStyle | string
  tabSize: number
  listIndentation: number
  frontmatterType: FrontmatterType | string
  superSubScript: boolean
  footnote: boolean
  isHtmlEnabled: boolean
  isGitlabCompatibilityEnabled: boolean
  sequenceTheme: SequenceTheme | string
  plantumlServer: string

  // ----- Theme -----
  theme: string
  followSystemTheme: boolean
  lightModeTheme: string
  darkModeTheme: string
  customCss: string

  // ----- Spellchecker -----
  spellcheckerEnabled: boolean
  spellcheckerNoUnderline: boolean
  spellcheckerLanguage: string

  // ----- Side bar / tab bar visibility (persisted) -----
  sideBarVisibility: boolean
  tabBarVisibility: boolean
  sourceCodeModeEnabled: boolean
  openedFilesInSidebar: boolean

  // ----- Search -----
  searchExclusions: string[]
  searchMaxFileSize: string
  searchIncludeHidden: boolean
  searchNoIgnore: boolean
  searchFollowSymlinks: boolean

  watcherUsePolling: boolean

  // ----- Edit modes (per-window, not persisted) -----
  typewriter: boolean
  focus: boolean
  sourceCode: boolean

  // ----- User config -----
  imageFolderPath: string
  webImages: unknown[]
  cloudImages: unknown[]
  currentUploader: string
  cliScript: string
}

interface SingleSetPreferencePayload {
  type: keyof PreferencesState | string
  value: unknown
}

interface SetUserDataPayload {
  type: string
  value: unknown
}

interface ModeTogglePayload {
  type: keyof PreferencesState | 'typewriter' | 'focus' | 'sourceCode'
  checked: boolean
}

export const usePreferencesStore = defineStore('preferences', {
  state: (): PreferencesState => ({
    autoSave: true,
    autoSaveDelay: 5000,
    annotationEnabled: true,
    annotationQuickPhrases: [...DEFAULT_QUICK_PHRASES],
    titleBarStyle: 'custom',
    openFilesInNewWindow: false,
    openFolderInNewWindow: false,
    zoom: 1.0,
    hideScrollbar: false,
    wordWrapInToc: false,
    fileSortBy: 'created',
    fileSortOrder: 'asc',
    startUpAction: 'blank',
    restoreLayoutState: true,
    defaultDirectoryToOpen: '',
    lastOpenedFolder: '',
    treePathExcludePatterns: [],
    language: 'en',

    editorFontFamily: 'Anthropic',
    fontSize: 15,
    lineHeight: 1.58,
    codeFontSize: 14,
    codeFontFamily: 'ui-monospace',
    codeBlockLineNumbers: false,
    trimUnnecessaryCodeBlockEmptyLines: true,
    wrapCodeBlocks: false,
    editorLineWidth: '100%',

    autoPairBracket: true,
    autoPairMarkdownSyntax: true,
    autoPairQuote: true,
    endOfLine: 'default',
    defaultEncoding: 'utf8',
    autoGuessEncoding: true,
    autoNormalizeLineEndings: false,

    trimTrailingNewline: 2,
    textDirection: 'ltr',
    hideQuickInsertHint: true,
    imageInsertAction: 'folder',
    imagePreferRelativeDirectory: false,
    imageRelativeDirectoryBase: 'file',
    imageRelativeDirectoryName: 'assets',
    imageInsertBehavior: 'render',
    imageUploaderEnabled: false,
    imageUploaderService: 'picgo',
    hideLinkPopup: false,
    autoCheck: false,

    preferLooseListItem: true,
    bulletListMarker: '-',
    orderListDelimiter: '.',
    preferHeadingStyle: 'atx',
    tabSize: 4,
    listIndentation: 1,
    frontmatterType: '-',
    superSubScript: false,
    footnote: false,
    isHtmlEnabled: true,
    isGitlabCompatibilityEnabled: false,
    sequenceTheme: 'hand',
    plantumlServer: 'https://www.plantuml.com/plantuml',

    theme: 'claude-light',
    followSystemTheme: true,
    lightModeTheme: 'claude-light',
    darkModeTheme: 'claude-dark',
    customCss: '',

    spellcheckerEnabled: false,
    spellcheckerNoUnderline: false,
    spellcheckerLanguage: 'en-US',

    // Default values that are overwritten with the entries below.
    // MoMark 裁决（QA-03/QA-02）：侧栏默认展开、标签栏常驻（含单文档态）。
    sideBarVisibility: true,
    tabBarVisibility: true,
    sourceCodeModeEnabled: false,
    openedFilesInSidebar: true,

    searchExclusions: [],
    searchMaxFileSize: '',
    searchIncludeHidden: false,
    searchNoIgnore: false,
    searchFollowSymlinks: true,

    watcherUsePolling: false,

    // --------------------------------------------------------------------------

    // Edit modes of the current window (not part of persistent settings)
    typewriter: false, // typewriter mode
    focus: false,
    sourceCode: false, // source code mode

    // user configration
    imageFolderPath: '',
    webImages: [],
    cloudImages: [],
    currentUploader: 'picgo',
    cliScript: ''
  }),

  getters: {
    getAll: (state): PreferencesState => state
  },

  actions: {
    SET_USER_PREFERENCE(preference: Partial<PreferencesState> | Record<string, unknown>): void {
      const oldLanguage = this.language

      Object.keys(preference).forEach((key) => {
        const incoming = (preference as Record<string, unknown>)[key]
        if (
          typeof incoming !== 'undefined' &&
          typeof (this as unknown as Record<string, unknown>)[key] !== 'undefined'
        ) {
          ;(this as unknown as Record<string, unknown>)[key] = incoming
        }
      })

      // Update i18n language if language preference changed
      const lang = (preference as { language?: string }).language
      if (lang && lang !== oldLanguage) {
        setLanguage(lang)
      }
    },

    SET_MODE({ type, checked }: ModeTogglePayload): void {
      ;(this as unknown as Record<string, unknown>)[type as string] = checked
    },

    TOGGLE_VIEW_MODE(entryName: keyof PreferencesState | string): void {
      const target = this as unknown as Record<string, unknown>
      target[entryName as string] = !target[entryName as string]
    },

    ASK_FOR_USER_PREFERENCE(): void {
      window.electron.ipcRenderer.send('mt::ask-for-user-preference')
      window.electron.ipcRenderer.send('mt::ask-for-user-data')

      window.electron.ipcRenderer.on('mt::user-preference', (_e, preferences) => {
        this.SET_USER_PREFERENCE(preferences as Partial<PreferencesState>)
      })
    },

    SET_SINGLE_PREFERENCE({ type, value }: SingleSetPreferencePayload): void {
      // Update local state
      ;(this as unknown as Record<string, unknown>)[type as string] = value

      // Update i18n language if language preference changed
      if (type === 'language' && typeof value === 'string') {
        setLanguage(value)
      }

      // save to electron-store
      window.electron.ipcRenderer.send('mt::set-user-preference', { [type as string]: value })
    },

    SET_USER_DATA({ type, value }: SetUserDataPayload): void {
      window.electron.ipcRenderer.send('mt::set-user-data', { [type]: value })
    },

    SET_IMAGE_FOLDER_PATH(value?: string): void {
      window.electron.ipcRenderer.send('mt::ask-for-modify-image-folder-path', value)
    },

    SELECT_DEFAULT_DIRECTORY_TO_OPEN(): void {
      window.electron.ipcRenderer.send('mt::select-default-directory-to-open')
    },

    LISTEN_FOR_VIEW(): void {
      window.electron.ipcRenderer.on('mt::show-command-palette', () => {
        bus.emit('show-command-palette')
      })
      window.electron.ipcRenderer.on('mt::toggle-view-mode-entry', (_event, entryName) => {
        this.TOGGLE_VIEW_MODE(entryName)
        const target = this as unknown as Record<string, unknown>
        this.DISPATCH_EDITOR_VIEW_STATE({ [entryName]: target[entryName] })
      })
    },

    // Toggle a view option and notify main process to toggle menu item.
    LISTEN_TOGGLE_VIEW(): void {
      bus.on('view:toggle-view-entry', (entryName) => {
        const name = entryName as string
        this.TOGGLE_VIEW_MODE(name)
        const target = this as unknown as Record<string, unknown>
        this.DISPATCH_EDITOR_VIEW_STATE({ [name]: target[name] })
      })
    },

    DISPATCH_EDITOR_VIEW_STATE(viewState: Record<string, unknown>): void {
      const { windowId } = window.marktext?.env ?? { windowId: -1 }
      window.electron.ipcRenderer.send('mt::view-layout-changed', windowId, viewState)
    }
  }
})
