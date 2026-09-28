import { describe, expect, it } from 'vitest';
import { resolveDraggedWidth } from '../htmlPreview';

// 拖拽落盘宽度的「不缩水」规则：存档尺寸比当前栏宽大时（在大窗口里调好的），
// 夹取只影响显示；随手拖一下不得把大尺寸永久改小（用户实测「每次打开块都变小」）。

describe('resolveDraggedWidth · 拖拽落盘宽度', () => {
    it('keeps the larger stored width when the drag only hits the ceiling', () => {
        // 存档 1200、栏宽 800：拖到顶格（显示仍是 800）不该把 1200 写成 800
        expect(resolveDraggedWidth(800, 800, 1200, 800)).toBe(1200);
        // 目标超出栏宽的拖动同样如此
        expect(resolveDraggedWidth(1500, 800, 1200, 800)).toBe(1200);
    });

    it('honours an explicit shrink', () => {
        // 起始显示宽 800，拖到 700（明确往小）→ 落盘 700
        expect(resolveDraggedWidth(700, 800, 1200, 800)).toBe(700);
        expect(resolveDraggedWidth(600, 800, 1200, 800)).toBe(600);
    });

    it('grows normally when there is no larger stored width', () => {
        // 无存档（0）：拖到多少就是多少
        expect(resolveDraggedWidth(900, 800, 0, 1000)).toBe(900);
        // 存档 500、拖到 900：取新值
        expect(resolveDraggedWidth(900, 800, 500, 1000)).toBe(900);
    });

    it('clamps to the layout width and the minimum', () => {
        // 栏宽 1000，拖到 1400 → 夹到 1000
        expect(resolveDraggedWidth(1400, 800, 0, 1000)).toBe(1000);
        // 下限 240
        expect(resolveDraggedWidth(100, 800, 0, 1000)).toBe(240);
        // 无可用宽度（量不到）时不设上限
        expect(resolveDraggedWidth(3000, 800, 0, Number.POSITIVE_INFINITY)).toBe(3000);
    });

    it('treats a sub-pixel move as "not shrinking"', () => {
        // 目标与起始显示宽持平时按「没往小拖」处理（保留更大的存档值）
        expect(resolveDraggedWidth(799.5, 800, 1200, 800)).toBe(1200);
    });
});
