import {
  THEME_STYLE_ID,
  COMMON_STYLE_ID,
  DEFAULT_CODE_FONT_FAMILY,
  oneDarkThemes,
  railscastsThemes
} from '../config'
import {
  graphite,
  materialDark,
  oneDark,
  ulysses,
  // New gogh themes - Dark
  dracula,
  nord,
  catppuccinMocha,
  gruvboxDark,
  tokyoNight,
  tokyoNightStorm,
  solarizedDark,
  ayuDark,
  ayuMirage,
  everforestDark,
  rosePine,
  rosePineMoon,
  monokaiPro,
  synthwave84,
  horizonDark,
  palenight,
  oxocarbonDark,
  kanagawa,
  nightfox,
  cyberdream,
  // New gogh themes - Light
  catppuccinLatte,
  gruvboxLight,
  tokyoNightLight,
  solarizedLight,
  ayuLight,
  everforestLight,
  rosePineDawn,
  // MoMark Claude 风格主题
  claudeLight,
  claudeDark
} from './themeColor'
import { isLinux } from './index'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ORIGINAL_THEME = '#409EFF'

const patchTheme = (css: string): string => {
  return `@media not print {\n${css}\n}`
}

const getEmojiPickerPatch = (): string => {
  return isLinux
    ? '.mu-emoji-picker section .emoji-wrapper .item span { font-family: sans-serif, "Noto Color Emoji"; }'
    : ''
}

export const addThemeStyle = (theme: string): void => {
  const isCmRailscasts = railscastsThemes.includes(theme)
  const isCmOneDark = oneDarkThemes.includes(theme)
  const isDarkTheme = isCmOneDark || isCmRailscasts
  let themeStyleEle = document.querySelector(`#${THEME_STYLE_ID}`) as HTMLStyleElement | null
  if (!themeStyleEle) {
    themeStyleEle = document.createElement('style')
    themeStyleEle.id = THEME_STYLE_ID
    document.head.appendChild(themeStyleEle)
  }

  switch (theme) {
    // 遗留默认主题 light/dark 一律渲染为墨记设计主题：
    // 老 marktext 默认样式体系已废弃，存量用户资料里的 light/dark
    // 也必须呈现 claude-light/claude-dark 的设计效果（chrome / 面板 /
    // 字体令牌 / 编辑器对齐），不再保留旧渲染。
    case 'light':
    case 'claude-light':
      themeStyleEle.innerHTML = patchTheme(claudeLight())
      break
    case 'dark':
    case 'claude-dark':
      themeStyleEle.innerHTML = patchTheme(claudeDark())
      break
    case 'material-dark':
      themeStyleEle.innerHTML = patchTheme(materialDark())
      break
    case 'ulysses':
      themeStyleEle.innerHTML = patchTheme(ulysses())
      break
    case 'graphite':
      themeStyleEle.innerHTML = patchTheme(graphite())
      break
    case 'one-dark':
      themeStyleEle.innerHTML = patchTheme(oneDark())
      break
    // New gogh themes - Dark
    case 'dracula':
      themeStyleEle.innerHTML = patchTheme(dracula())
      break
    case 'nord':
      themeStyleEle.innerHTML = patchTheme(nord())
      break
    case 'catppuccin-mocha':
      themeStyleEle.innerHTML = patchTheme(catppuccinMocha())
      break
    case 'gruvbox-dark':
      themeStyleEle.innerHTML = patchTheme(gruvboxDark())
      break
    case 'tokyo-night':
      themeStyleEle.innerHTML = patchTheme(tokyoNight())
      break
    case 'tokyo-night-storm':
      themeStyleEle.innerHTML = patchTheme(tokyoNightStorm())
      break
    case 'solarized-dark':
      themeStyleEle.innerHTML = patchTheme(solarizedDark())
      break
    case 'ayu-dark':
      themeStyleEle.innerHTML = patchTheme(ayuDark())
      break
    case 'ayu-mirage':
      themeStyleEle.innerHTML = patchTheme(ayuMirage())
      break
    case 'everforest-dark':
      themeStyleEle.innerHTML = patchTheme(everforestDark())
      break
    case 'rose-pine':
      themeStyleEle.innerHTML = patchTheme(rosePine())
      break
    case 'rose-pine-moon':
      themeStyleEle.innerHTML = patchTheme(rosePineMoon())
      break
    case 'monokai-pro':
      themeStyleEle.innerHTML = patchTheme(monokaiPro())
      break
    case 'synthwave-84':
      themeStyleEle.innerHTML = patchTheme(synthwave84())
      break
    case 'horizon-dark':
      themeStyleEle.innerHTML = patchTheme(horizonDark())
      break
    case 'palenight':
      themeStyleEle.innerHTML = patchTheme(palenight())
      break
    case 'oxocarbon-dark':
      themeStyleEle.innerHTML = patchTheme(oxocarbonDark())
      break
    case 'kanagawa':
      themeStyleEle.innerHTML = patchTheme(kanagawa())
      break
    case 'nightfox':
      themeStyleEle.innerHTML = patchTheme(nightfox())
      break
    case 'cyberdream':
      themeStyleEle.innerHTML = patchTheme(cyberdream())
      break
    // New gogh themes - Light
    case 'catppuccin-latte':
      themeStyleEle.innerHTML = patchTheme(catppuccinLatte())
      break
    case 'gruvbox-light':
      themeStyleEle.innerHTML = patchTheme(gruvboxLight())
      break
    case 'tokyo-night-light':
      themeStyleEle.innerHTML = patchTheme(tokyoNightLight())
      break
    case 'solarized-light':
      themeStyleEle.innerHTML = patchTheme(solarizedLight())
      break
    case 'ayu-light':
      themeStyleEle.innerHTML = patchTheme(ayuLight())
      break
    case 'everforest-light':
      themeStyleEle.innerHTML = patchTheme(everforestLight())
      break
    case 'rose-pine-dawn':
      themeStyleEle.innerHTML = patchTheme(rosePineDawn())
      break
    default:
      break
  }

  // workaround: use dark icons
  document.body.classList.remove('dark')
  if (isDarkTheme) {
    document.body.classList.add('dark')
  }

  // MoMark 设计体系作用域（合并裁决：html+body 双标记都挂）：
  // ① tokens.css 的深色段 [data-theme="dark"] 由 html 标记驱动；
  // ② chrome 样式读取 body[data-theme]（feat/chrome 实现）；
  // ③ claude-editor.css 的 §6 编辑器对齐仅在 body.is-claude-theme 下生效；
  // 遗留默认主题 light/dark 已并入设计主题（见上方 switch），
  // 其余历史主题（gogh 等）保持原渲染。
  const isMoMarkTheme =
    theme === 'light' || theme === 'dark' || theme === 'claude-light' || theme === 'claude-dark'
  const darkMarker = isDarkTheme || theme === 'dark' || theme === 'claude-dark' ? 'dark' : 'light'
  document.documentElement.dataset.theme = darkMarker
  document.body.dataset.theme = darkMarker
  document.body.classList.toggle('is-claude-theme', isMoMarkTheme)

  // change CodeMirror theme
  const cm = document.querySelector('.CodeMirror')
  if (cm) {
    cm.classList.remove('cm-s-default')
    cm.classList.remove('cm-s-one-dark')
    cm.classList.remove('cm-s-railscasts')
    if (isCmOneDark) {
      cm.classList.add('cm-s-one-dark')
    } else if (isCmRailscasts) {
      cm.classList.add('cm-s-railscasts')
    } else {
      cm.classList.add('cm-s-default')
    }
  }
}

export const setEditorWidth = (value: string): void => {
  const EDITOR_WIDTH_STYLE_ID = 'editor-width'
  let result = ''
  if (value && /^[0-9]+(?:ch|px|%)$/.test(value)) {
    // Percentage widths are relative to the editor panel itself, so no
    // padding compensation (100px + 100% would overflow the viewport).
    // ch/px values add 100px for the container's horizontal padding.
    // Sets both the legacy camelCase var (source mode) and the kebab-case
    // var the @muyajs/core engine reads for `.mu-container` max-width
    // (issue #4828).
    const width = value.endsWith('%') ? value : `calc(100px + ${value})`
    result = `:root { --editorAreaWidth: ${width}; --editor-area-width: ${width}; }`
  }
  let styleEle = document.querySelector(`#${EDITOR_WIDTH_STYLE_ID}`) as HTMLStyleElement | null
  if (!styleEle) {
    styleEle = document.createElement('style')
    styleEle.setAttribute('id', EDITOR_WIDTH_STYLE_ID)
    document.head.appendChild(styleEle)
  }

  styleEle.innerHTML = result
}

export interface CommonStyleOptions {
  codeFontFamily: string
  codeFontSize: number | string
  hideScrollbar?: boolean
  [key: string]: unknown
}

export const addCommonStyle = (options: CommonStyleOptions): void => {
  const { codeFontFamily, codeFontSize, hideScrollbar } = options
  let sheet = document.querySelector(`#${COMMON_STYLE_ID}`) as HTMLStyleElement | null
  if (!sheet) {
    sheet = document.createElement('style')
    sheet.id = COMMON_STYLE_ID
    document.head.appendChild(sheet)
  }

  let scrollbarStyle = ''
  if (hideScrollbar) {
    scrollbarStyle = '::-webkit-scrollbar {display: none;}'
  }

  sheet.innerHTML = `${scrollbarStyle}
.CodeMirror {
font-family: ${codeFontFamily}, ${DEFAULT_CODE_FONT_FAMILY};
font-size: ${codeFontSize}px;
}

${getEmojiPickerPatch()}
`
}

export interface CustomStyleOptions {
  customCss?: string
  [key: string]: unknown
}

export const addCustomStyle = (options: CustomStyleOptions): void => {
  const { customCss } = options
  if (!customCss) return

  let customStyleEle = document.querySelector('#custom-styles') as HTMLStyleElement | null
  if (!customStyleEle) {
    customStyleEle = document.createElement('style')
    customStyleEle.id = 'custom-styles'
    document.head.appendChild(customStyleEle)
  }
  customStyleEle.innerHTML = customCss
}

export interface AddStylesOptions extends CommonStyleOptions {
  theme: string
}

// Append common sheet and theme at the end of head - order is important.
export const addStyles = (options: AddStylesOptions): void => {
  const { theme } = options
  addThemeStyle(theme)
  addCommonStyle(options)
}
