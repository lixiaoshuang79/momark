/**
 * 缩放快捷键归属判定（round18）。
 *
 * 背景：墨记沿用上游 MarkText 的键位表，`Command+=` / `Command+-` / `Command+0`
 * 默认是**段落标题升降级**（keybindingsDarwin.ts 的 paragraph.upgrade-heading /
 * paragraph.degrade-heading / paragraph.paragraph）。右侧网页面板用同一组键做
 * 网页缩放，于是产生冲突： guest 抢到键盘焦点时按键走 guest（能缩放网页），
 * 一旦焦点回到宿主窗口，同一个键就变成「改左侧文档的段落标题」—— 用户报的
 * 「按 Cmd+/- 网页不缩放，放大缩小的效果转移到左侧文档」即此。
 *
 * 这里把判定抽成不依赖 electron 的纯函数，便于表驱动单测覆盖所有上下文组合。
 */

import type { BpZoomAction } from '@shared/types/ipc'

/** 面板输入上下文（渲染层 bp:setInputContext 推送）。 */
export interface PanelInputContext {
  /** 右栏是否展开 */
  open: boolean
  /** 右栏当前模式：网页 / 文档 */
  mode: 'url' | 'doc'
  /** 网页模式下当前激活页 id（无页为 null） */
  activePageId: string | null
  /** 键盘光标是否在编辑器里（在写文档） */
  editorFocused: boolean
}

/**
 * 与网页面板缩放冲突的命令 → 缩放意图。
 * 三个命令在 mac 上的默认加速键分别是 Command+= / Command+- / Command+0。
 */
export const PANEL_ZOOM_COMMANDS: Record<string, BpZoomAction> = {
  'paragraph.upgrade-heading': 'in',
  'paragraph.degrade-heading': 'out',
  'paragraph.paragraph': 'reset'
}

/** 命令 id → 缩放意图；不是缩放命令返回 null。 */
export const zoomActionForCommand = (commandId: string): BpZoomAction | null =>
  PANEL_ZOOM_COMMANDS[commandId] ?? null

/**
 * 网页面板是否应当接管这个缩放键。
 * 条件：面板展开 + 网页模式 + 有激活页 + 光标不在编辑器里。
 * 「光标在编辑器里」= 用户在写文档，保留段落标题语义，不抢。
 */
export const panelOwnsZoomKey = (ctx: PanelInputContext | undefined | null): boolean => {
  if (!ctx) return false
  if (!ctx.open) return false
  if (ctx.mode !== 'url') return false
  if (!ctx.activePageId) return false
  if (ctx.editorFocused) return false
  return true
}
