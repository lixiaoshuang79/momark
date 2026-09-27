// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { union } from '../../utils';

// `utils.union` 把行内高亮切成区间挂到 token 上，是搜索高亮与标注高亮的公共通道。
// 两条不能破的性质：
//   1. 缺省 type='search' —— 搜索的 IHighlight 不带 type/data，行为必须与改造前
//      逐字一致（start/end 取交集，active 取第二个参数）。
//   2. type/data 透传 + 重叠优先级 annotation-active > annotation > search，
//      同级重叠取序号更小的数据（方案 §3.6「重叠区用序号更小的样式」）。

describe('union() 旧行为（缺省 search）', () => {
    it('区间不相交返回 null', () => {
        expect(union({ start: 0, end: 3 }, { start: 3, end: 6, active: false })).toBeNull();
        expect(union({ start: 4, end: 6 }, { start: 0, end: 4, active: true })).toBeNull();
        expect(union({ start: 0, end: 2 }, { start: 5, end: 9, active: true })).toBeNull();
    });

    it('相交时取交集、active 来自第二个参数、type 缺省为 search', () => {
        expect(union({ start: 2, end: 8 }, { start: 5, end: 12, active: true })).toEqual({
            start: 5,
            end: 8,
            active: true,
            type: 'search',
            data: undefined,
        });

        // 高亮完全包住 token 区间：交集就是 token 区间。
        expect(union({ start: 3, end: 6 }, { start: 0, end: 9, active: false })).toEqual({
            start: 3,
            end: 6,
            active: false,
            type: 'search',
            data: undefined,
        });
    });
});

describe('union() 类型透传与优先级', () => {
    it('标注高亮的 type/data 透传下来', () => {
        expect(
            union({ start: 0, end: 4 }, { start: 2, end: 6, active: false, type: 'annotation', data: { index: 2 } }),
        ).toEqual({ start: 2, end: 4, active: false, type: 'annotation', data: { index: 2 } });
    });

    it('annotation > search（两个方向都成立）', () => {
        expect(
            union({ start: 0, end: 4, type: 'search' }, { start: 2, end: 6, active: true, type: 'annotation', data: { index: 1 } }),
        ).toMatchObject({ type: 'annotation', data: { index: 1 } });

        expect(
            union({ start: 0, end: 4, type: 'annotation', data: { index: 1 } }, { start: 2, end: 6, active: true }),
        ).toMatchObject({ type: 'annotation', data: { index: 1 } });
    });

    it('annotation-active > annotation', () => {
        expect(
            union(
                { start: 0, end: 6, type: 'annotation', data: { index: 1 } },
                { start: 2, end: 8, type: 'annotation-active', data: { index: 4 } },
            ),
        ).toMatchObject({ type: 'annotation-active', data: { index: 4 } });

        expect(
            union(
                { start: 0, end: 6, type: 'annotation-active', data: { index: 4 } },
                { start: 2, end: 8, type: 'annotation', data: { index: 1 } },
            ),
        ).toMatchObject({ type: 'annotation-active', data: { index: 4 } });
    });

    it('同级标注重叠时取序号更小的那条数据（含序号缺失的情况）', () => {
        expect(
            union(
                { start: 0, end: 6, type: 'annotation', data: { index: 3 } },
                { start: 2, end: 8, type: 'annotation', data: { index: 1 } },
            ),
        ).toMatchObject({ type: 'annotation', data: { index: 1 } });

        // 非首段（无序号）让位给带序号的。
        expect(
            union(
                { start: 0, end: 6, type: 'annotation', data: {} },
                { start: 2, end: 8, type: 'annotation', data: { index: 2 } },
            ),
        ).toMatchObject({ type: 'annotation', data: { index: 2 } });
    });

    it('active 仍然只来自第二个参数（旧语义不变）', () => {
        expect(union({ start: 0, end: 4, active: true }, { start: 2, end: 6, active: false })).toMatchObject({
            active: false,
        });
    });
});
