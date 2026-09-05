/**
 * 命令面板 5 分组模型（墨记 / 文件 / 编辑 / 视图 / 格式）。
 *
 * 以「实际已实现的菜单命令」为真源：`commands/index.ts` 中真实存在、可执行的
 * 命令才会出现在面板里；design/commands.json 中未实现的条目（关于墨记、拼写检查
 * 等）一律不加入。数组顺序即组内展示顺序（贴近菜单顺序）。
 *
 * 特殊条目：
 *  - 'file.export-file-html|pdf|docx' 是父命令 file.export-file 的叶子子命令，
 *    在面板里被扁平化成三条独立命令（与产品清单一致）。
 */
import { t } from '../../i18n'

export type PaletteGroupKey = 'momark' | 'file' | 'edit' | 'view' | 'format'

interface PaletteGroupDef {
  key: PaletteGroupKey
  /** i18n key，形如 commandPalette.groups.file */
  labelKey: string
  commands: string[]
}

export const PALETTE_GROUP_DEFS: PaletteGroupDef[] = [
  {
    key: 'momark',
    labelKey: 'commandPalette.groups.momark',
    commands: ['file.preferences']
  },
  {
    key: 'file',
    labelKey: 'commandPalette.groups.file',
    commands: [
      'file.new-tab',
      'file.open-file',
      'file.open-folder',
      'file.save',
      'file.save-as',
      'file.export-file-html',
      'file.export-file-pdf',
      'file.export-file-docx',
      'file.print',
      'file.import-file',
      'file.close-tab',
      'file.close-window'
    ]
  },
  {
    key: 'edit',
    labelKey: 'commandPalette.groups.edit',
    commands: ['edit.undo', 'edit.redo', 'edit.find', 'edit.replace', 'edit.find-in-folder']
  },
  {
    key: 'view',
    labelKey: 'commandPalette.groups.view',
    commands: [
      'view.focus-mode',
      'view.toggle-sidebar',
      'view.toggle-tabbar',
      'window.change-theme',
      'file.zoom',
      'view.text-direction'
    ]
  },
  {
    key: 'format',
    labelKey: 'commandPalette.groups.format',
    commands: [
      'paragraph.heading-1',
      'format.strong',
      'format.emphasis',
      'format.strike',
      'paragraph.quote-block',
      'format.hyperlink',
      'paragraph.table',
      'paragraph.code-fence',
      'format.image',
      'paragraph.math-formula'
    ]
  }
]

/** 扁平化叶子子命令（导出 HTML/PDF/docx 三条）。 */
export const FLATTENED_LEAVES = new Set([
  'file.export-file-html',
  'file.export-file-pdf',
  'file.export-file-docx'
])

export const groupLabel = (key: PaletteGroupKey): string => {
  const def = PALETTE_GROUP_DEFS.find((g) => g.key === key)
  return def ? t(def.labelKey) : key
}
