/* eslint-disable @typescript-eslint/no-explicit-any --
 * Type surface for the TypeScript muya engine published as `@muyajs/core`
 * (packages/muya), scoped to what the desktop consumes.
 *
 * Why a hand-written declaration instead of the package's own types: the
 * `@muyajs/core` package `exports` map points `.` at `./src/index.ts`, and it
 * ships no built `lib/types/*.d.ts` at install time. If vue-tsc resolved the
 * import to that source it would type-check the entire muya tree under the
 * desktop's program — where muya's own `src/types/global.d.ts` globals (e.g.
 * `Element.__MUYA_BLOCK__`) are absent — producing spurious errors. A `paths`
 * entry in tsconfig.base.json redirects `@muyajs/core` here, cutting the
 * dependency graph at the import boundary (the same shielding the legacy
 * `@marktext/muyajs` engine gets via `muya.d.ts`). Vite/electron-vite still
 * resolve the real runtime module via the package `exports` map at build time.
 *
 * Delete this file (and the `paths` entry) once `@muyajs/core` ships built
 * `lib/types/*.d.ts` and can be resolved as a normal typed dependency.
 */

declare module '@muyajs/core' {
  export interface ILocale {
    name: string
    resource: Record<string, string>
  }

  // Bundled locale objects.
  export const en: ILocale
  export const de: ILocale
  export const es: ILocale
  export const fr: ILocale
  export const ja: ILocale
  export const ko: ILocale
  export const pt: ILocale
  export const tr: ILocale
  export const zhCN: ILocale
  export const zhTW: ILocale

  export interface ITocItem {
    content: string
    lvl: number
    slug: string
    githubSlug: string
  }

  // The editor instance surface is kept permissive (`any`) — every member
  // that crosses the editor boundary was already `any` in editor.vue.
  export class Muya {
    static use(plugin: any, options?: Record<string, unknown>): void
    constructor(element: HTMLElement, options?: Record<string, unknown>)
    init(): void
    [key: string]: any
  }

  // UI plugins (constructors registered via `Muya.use`).
  export const AnnotationTool: any
  export const CodeBlockLanguageSelector: any
  export const EmojiSelector: any
  export const FootnoteTool: any
  export const ImageEditTool: any
  export const ImagePathPicker: any
  export const ImageResizeBar: any
  export const ImageToolBar: any
  export const InlineFormatToolbar: any
  export const LinkTools: any
  export const ParagraphFrontButton: any
  export const ParagraphFrontMenu: any
  export const ParagraphQuickInsertMenu: any
  export const PreviewToolBar: any
  export const TableChessboard: any
  export const TableColumnToolbar: any
  export const TableDragBar: any
  export const TableRowColumMenu: any

  export class MarkdownToHtml {
    markdown: string
    constructor(markdown: string, muya?: unknown)
    renderHtml(): Promise<string>
    generate(options?: {
      title?: string
      extraCSS?: string
      inlineStyles?: boolean
      dir?: string
    }): Promise<string>
  }

  export function renderToStaticHTML(...args: any[]): any

  export function escapeHTML(str: string): string
  export function unescapeHTML(str: string): string
  export function sanitize(html: string, config?: any, isInline?: boolean): string
  export function generateGithubSlug(text: string): string
  export function getImageInfo(src: string): {
    isUnknownType: boolean
    src: string
    [key: string]: any
  }
  export function wordCount(markdown: string): {
    word: number
    paragraph: number
    character: number
    all: number
  }

  /** 块级内嵌 HTML 块在 markdown 里的行范围（`end` 不含；空行终结符不算块内）。 */
  export interface IHtmlBlockSpan {
    start: number
    end: number
    text: string
    blankTerminated: boolean
  }
  export function findHtmlBlockSpans(markdown: string): IHtmlBlockSpan[]

  /** 编辑器里带沙箱帧的内嵌 HTML 块：源码 + 当前显示尺寸 + 缩放倍数。 */
  export interface IHtmlFrameTarget {
    html: string
    width: number
    height: number
    zoom: number
    /** 用户没单独调过宽度（跟随布局）→ 导出时按页面宽度铺满 */
    auto: boolean
  }
  export function collectHtmlFrameTargets(root: ParentNode | null | undefined): IHtmlFrameTarget[]
}

/**
 * 常用语（feat/quick-phrases）的规范化与上限：唯一一份规则在
 * `packages/muya/src/annotation/quickPhrase.ts`，卡片的判定、桌面的写入
 * （store/annotation.ts）与设置弹窗（quickPhraseSettings.vue）共用，桌面不抄。
 *
 * 走子路径而不是包根：`packages/muya/src/index.ts` 的手写导出表里还没有这些
 * 名字（引擎侧分工也不含 index.ts），而包的 exports 映射
 * `"./*": "./src/*"` 保证子路径可用；副作用也更小——包根会把整个引擎拉进
 * `store/preferences.ts` 消费者的模块图。引擎从包根转出后，桌面可一行切回。
 */
declare module '@muyajs/core/annotation/quickPhrase' {
  export const QUICK_PHRASE_MAX_LEN: number
  export const QUICK_PHRASE_MAX_COUNT: number
  export function normalizePhrase(value: unknown): string
  export function normalizePhraseList(list: unknown, maxCount?: number): string[]
}
