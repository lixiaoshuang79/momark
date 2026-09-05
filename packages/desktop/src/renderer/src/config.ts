export const PATH_SEPARATOR: string = window.path.sep

export const THEME_STYLE_ID = 'ag-theme'
export const COMMON_STYLE_ID = 'ag-common-style'

export const DEFAULT_EDITOR_FONT_FAMILY =
  '"Anthropic", "Geist", -apple-system, "PingFang SC", sans-serif, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji"'
export const DEFAULT_CODE_FONT_FAMILY =
  'ui-monospace, "SF Mono", Menlo, monospace, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji"'
export const DEFAULT_STYLE = Object.freeze({
  codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
  codeFontSize: '14px',
  hideScrollbar: false,
  theme: 'claude-light'
})

export { railscastsThemes, oneDarkThemes } from '../../common/theme'
