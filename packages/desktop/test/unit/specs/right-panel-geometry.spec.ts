import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANEL_RATIO,
  DEFAULT_SPLIT_RATIO,
  dragWidth,
  panelBounds,
  panelGeometry,
  ratioFromWidth,
  sanitizeRatio,
  snapLines
} from '@/store/panelGeometry'

describe('panelGeometry: 面板宽 = clamp(最小值, 比例 × 可用宽, 最大值)', () => {
  it('按 30% 比例随屏幕变化（DESIGN-NOTES §1 实测表）', () => {
    expect(panelGeometry(DEFAULT_PANEL_RATIO, 2240, 'panel').width).toBe(672)
    expect(panelGeometry(DEFAULT_PANEL_RATIO, 1680, 'panel').width).toBe(504)
    expect(panelGeometry(DEFAULT_PANEL_RATIO, 1440, 'panel').width).toBe(432)
    expect(panelGeometry(DEFAULT_PANEL_RATIO, 1180, 'panel').width).toBe(354)
  })

  it('窄窗夹到 280 下限；< 760 改为浮层', () => {
    const narrow = panelGeometry(DEFAULT_PANEL_RATIO, 900, 'panel')
    expect(narrow).toMatchObject({ width: 280, overlay: false })
    const tiny = panelGeometry(DEFAULT_PANEL_RATIO, 700, 'panel')
    expect(tiny.overlay).toBe(true)
    expect(tiny.width).toBe(280)
    expect(panelBounds(760, 'panel').overlay).toBe(false)
    expect(panelBounds(759, 'panel').overlay).toBe(true)
  })

  it('最大值 = min(60%, 可用宽 − 480)', () => {
    expect(panelBounds(2000, 'panel').max).toBe(1200)
    expect(panelBounds(1000, 'panel').max).toBe(520)
    expect(panelGeometry(0.9, 1440, 'panel').width).toBe(864)
  })

  it('分屏默认 50%、下限 360（窄一些时让位给最大值，但不低于 280）', () => {
    expect(panelGeometry(DEFAULT_SPLIT_RATIO, 1440, 'split').width).toBe(720)
    expect(panelGeometry(DEFAULT_SPLIT_RATIO, 1440, 'split').width).toBeLessThanOrEqual(
      panelBounds(1440, 'split').max
    )
    const b = panelBounds(800, 'split')
    expect(b.min).toBe(320)
    expect(b.max).toBe(320)
  })

  it('坏的落盘比例不让 UI 崩：回到默认值', () => {
    expect(sanitizeRatio(undefined, 'panel')).toBe(DEFAULT_PANEL_RATIO)
    expect(sanitizeRatio(Number.NaN, 'panel')).toBe(DEFAULT_PANEL_RATIO)
    expect(sanitizeRatio('0.4', 'split')).toBe(DEFAULT_SPLIT_RATIO)
    expect(sanitizeRatio(288, 'panel')).toBe(DEFAULT_PANEL_RATIO)
    expect(sanitizeRatio(0.42, 'panel')).toBe(0.42)
    expect(panelGeometry(Number.NaN, 1440, 'panel').width).toBe(432)
  })

  it('记住的是比例：像素 → 比例 → 换屏幕后同比例', () => {
    const ratio = ratioFromWidth(480, 1440, 'panel')
    expect(ratio).toBeCloseTo(0.333, 3)
    expect(panelGeometry(ratio, 2240, 'panel').width).toBe(746)
  })
})

describe('dragWidth: 吸附与软边界', () => {
  it('10px 内吸附到 ⅓ / ½ / 默认', () => {
    const r = dragWidth(486, 1440, 'panel')
    expect(r).toMatchObject({ px: 480, snapped: 'third', limit: null })
    expect(dragWidth(436, 1440, 'panel').snapped).toBe('default')
    expect(dragWidth(600, 1440, 'panel').snapped).toBeNull()
  })

  it('越过下限：0.18 倍阻尼、最多多拖 14px，松手回到边界', () => {
    const r = dragWidth(200, 1440, 'panel')
    expect(r.limit).toBe('min')
    expect(r.settle).toBe(280)
    expect(r.px).toBe(280 - 14)
    expect(dragWidth(270, 1440, 'panel').px).toBe(278)
  })

  it('越过上限说明原因：60% 或为正文保留 480', () => {
    expect(dragWidth(1500, 2000, 'panel').limit).toBe('max')
    expect(dragWidth(700, 1000, 'panel').limit).toBe('editor')
    expect(dragWidth(700, 1000, 'panel').settle).toBe(520)
  })

  it('分屏的 ½ 与默认重合时只留一条吸附线', () => {
    const lines = snapLines(1440, 'split', panelBounds(1440, 'split'))
    expect(lines.map((l) => l.id)).toEqual(['third', 'half'])
  })
})
