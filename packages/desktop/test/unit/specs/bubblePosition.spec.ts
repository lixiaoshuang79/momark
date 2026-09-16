import { describe, expect, it } from 'vitest'
import { isUsableAnchor, placeBubble, type RectLike } from '@/util/bubblePosition'

const rect = (left: number, top: number, width: number, height: number): RectLike => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height
})

// 编辑区：标签栏下方开始，右侧留 20px 内边距的常见形态
const BOUNDS = rect(80, 96, 900, 700) // left/top 起，right=980，bottom=796
const BUBBLE = { width: 300, height: 150 }

describe('isUsableAnchor', () => {
    it('空文档里 collapsed range 的 0×0 原点矩形不算可用', () => {
        expect(isUsableAnchor(rect(0, 0, 0, 0))).toBe(false)
    })

    it('没有选区时不可用', () => {
        expect(isUsableAnchor(null)).toBe(false)
        expect(isUsableAnchor(undefined)).toBe(false)
    })

    it('折叠光标（宽 0 高 21）可用', () => {
        expect(isUsableAnchor(rect(104, 128, 0, 21))).toBe(true)
    })

    it('非折叠选区可用', () => {
        expect(isUsableAnchor(rect(104, 128, 60, 21))).toBe(true)
    })
})

describe('placeBubble', () => {
    it('空文档（锚点退化）时落在编辑区左上角，而不是窗口左上角', () => {
        // 复现用户 2026-09-16 截图里的 bug：0×0 原点矩形曾被当成真实锚点，
        // 气泡被 Math.max(12, …) 贴到了窗口角、压住标签栏。
        const { x, y } = placeBubble({ anchor: rect(0, 0, 0, 0), bounds: BOUNDS, bubble: BUBBLE })

        expect(x).toBe(BOUNDS.left + 8)
        expect(y).toBe(BOUNDS.top + 8)
    })

    it('光标在文档中部时贴在光标下方、与光标行左对齐', () => {
        const anchor = rect(120, 200, 0, 22)
        const { x, y, above } = placeBubble({ anchor, bounds: BOUNDS, bubble: BUBBLE })

        expect(x).toBe(120)
        expect(y).toBe(230) // bottom 222 + gap 8
        expect(above).toBe(false)
    })

    it('光标靠近底部、下方放不下时翻到上方', () => {
        const anchor = rect(120, 700, 0, 22) // bottom 722，下方只剩 74px
        const { y, above } = placeBubble({ anchor, bounds: BOUNDS, bubble: BUBBLE })

        expect(above).toBe(true)
        expect(y).toBe(700 - 150 - 8)
    })

    it('光标贴右边界时气泡收回编辑区内，不越界', () => {
        const anchor = rect(960, 200, 0, 22)
        const { x } = placeBubble({ anchor, bounds: BOUNDS, bubble: BUBBLE })

        expect(x).toBe(BOUNDS.right - BUBBLE.width - 8)
    })

    it('编辑区比气泡还小时仍然不越界', () => {
        const tiny = rect(80, 96, 200, 120)
        const { x, y } = placeBubble({ anchor: rect(100, 150, 0, 22), bounds: tiny, bubble: BUBBLE })

        expect(x).toBeGreaterThanOrEqual(tiny.left)
        expect(y).toBeGreaterThanOrEqual(tiny.top)
    })

    it('气泡永远不低于 bounds.top —— 也就是永远不盖住标签栏', () => {
        for (const top of [0, 20, 96, 300, 750]) {
            const anchor = rect(120, top, 0, 22)
            const { y } = placeBubble({ anchor, bounds: BOUNDS, bubble: BUBBLE })

            expect(y).toBeGreaterThanOrEqual(BOUNDS.top + 8)
        }
    })

    it('锚点为空时同样走兜底位置', () => {
        const { x, y } = placeBubble({ anchor: null, bounds: BOUNDS, bubble: BUBBLE })

        expect(x).toBe(BOUNDS.left + 8)
        expect(y).toBe(BOUNDS.top + 8)
    })
})
