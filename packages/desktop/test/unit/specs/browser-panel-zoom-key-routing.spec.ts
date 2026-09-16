import { describe, expect, it } from 'vitest'
import {
  PANEL_ZOOM_COMMANDS,
  panelOwnsZoomKey,
  zoomActionForCommand,
  type PanelInputContext
} from 'main_renderer/browserPanelKeyRouting'

/**
 * round18：缩放快捷键归属判定的表驱动单测。
 *
 * 这是本轮唯一能脱离「真实 OS 按键」验证的关键逻辑：Command+= / Command+-
 * / Command+0 在墨记里默认是段落标题升降级，右栏网页面板要拿它们做网页缩放。
 * 判定错一次的后果很实在 —— 用户按「网页放大」会改掉左侧文档的段落级别。
 */

const base: PanelInputContext = {
  open: true,
  mode: 'url',
  activePageId: 'bp-1',
  editorFocused: false
}

describe('zoomActionForCommand', () => {
  it('三个标题命令各自映射到缩放意图', () => {
    expect(zoomActionForCommand('paragraph.upgrade-heading')).toBe('in')
    expect(zoomActionForCommand('paragraph.degrade-heading')).toBe('out')
    expect(zoomActionForCommand('paragraph.paragraph')).toBe('reset')
  })

  it('非缩放命令一律不接管', () => {
    for (const id of [
      'file.save',
      'view.toggle-sidebar',
      'paragraph.heading-1',
      'edit.copy',
      'window.zoomIn'
    ]) {
      expect(zoomActionForCommand(id)).toBeNull()
      expect(id in PANEL_ZOOM_COMMANDS).toBe(false)
    }
  })
})

describe('panelOwnsZoomKey', () => {
  it('面板展开 + 网页模式 + 有激活页 + 光标不在编辑器 → 归网页', () => {
    expect(panelOwnsZoomKey(base)).toBe(true)
  })

  it('光标在编辑器里 → 不抢（保留段落标题语义）', () => {
    expect(panelOwnsZoomKey({ ...base, editorFocused: true })).toBe(false)
  })

  it('面板收起 → 不抢', () => {
    expect(panelOwnsZoomKey({ ...base, open: false })).toBe(false)
  })

  it('文档模式 → 不抢', () => {
    expect(panelOwnsZoomKey({ ...base, mode: 'doc' })).toBe(false)
  })

  it('网页模式但没有激活页 → 不抢（无缩放对象）', () => {
    expect(panelOwnsZoomKey({ ...base, activePageId: null })).toBe(false)
  })

  it('上下文缺失（渲染层还没推过）→ 不抢', () => {
    expect(panelOwnsZoomKey(undefined)).toBe(false)
    expect(panelOwnsZoomKey(null)).toBe(false)
  })

  it('只有全部条件同时成立才接管（逐条翻转都不接管）', () => {
    const flips: Array<Partial<PanelInputContext>> = [
      { open: false },
      { mode: 'doc' },
      { activePageId: null },
      { editorFocused: true }
    ]
    for (const flip of flips) {
      expect(panelOwnsZoomKey({ ...base, ...flip })).toBe(false)
    }
    expect(panelOwnsZoomKey(base)).toBe(true)
  })
})
