// @vitest-environment happy-dom

import type { Muya } from '../../../index';
import { describe, expect, it, vi } from 'vitest';
import BaseFloat from '../index';

// REGRESSION GUARD — 浮层贴边伸出窗口。
//
// `flip` 只在 placement 的方向之间换（上↔下），居中放置的卡片贴着窗口左/右边缘时
// 仍有一半在窗口外（用户实测：标注卡片跑到窗口左边外面）。带 `shiftPadding` 的
// 浮层要多挂一层 floating-ui 的 `shift`，把卡片沿交叉轴夹回视口内。

interface IComputeOptions {
    middleware: { name: string }[];
}

const mocks = vi.hoisted(() => ({
    computePosition: vi.fn(
        async (_reference: unknown, _float: unknown, _options: IComputeOptions) => ({
            x: 0,
            y: 0,
            placement: 'bottom',
        }),
    ),
    shift: vi.fn((options: unknown) => ({ name: 'shift', options })),
    flip: vi.fn(() => ({ name: 'flip', fn: () => ({}) })),
    offset: vi.fn((options: unknown) => ({ name: 'offset', options })),
}));

vi.mock('@floating-ui/dom', () => ({
    autoUpdate: (_reference: unknown, _float: unknown, update: () => void) => {
        update();

        return () => {};
    },
    computePosition: mocks.computePosition,
    flip: mocks.flip,
    offset: mocks.offset,
    shift: mocks.shift,
}));

class TestFloat extends BaseFloat {}

function makeFloat(options = {}): TestFloat {
    const muya = { eventCenter: { emit: vi.fn() } } as unknown as Muya;

    return new TestFloat(muya, 'mu-test-shift-float', options);
}

const reference = {
    getBoundingClientRect: () => ({
        x: -200,
        y: 300,
        top: 300,
        left: -200,
        right: -100,
        bottom: 320,
        width: 100,
        height: 20,
        toJSON() {},
    }),
};

describe('baseFloat shiftPadding', () => {
    it('clamps the float into the viewport when shiftPadding is set', async () => {
        const float = makeFloat({ shiftPadding: 8 });
        float.show(reference);
        await Promise.resolve();

        expect(mocks.shift).toHaveBeenCalledWith({ padding: 8, crossAxis: true });
        const { middleware } = mocks.computePosition.mock.calls[0]![2];
        expect(middleware.map((item) => item.name)).toEqual(['offset', 'flip', 'shift']);
    });

    it('leaves other floats untouched by default', async () => {
        mocks.shift.mockClear();
        const float = makeFloat();
        float.show(reference);
        await Promise.resolve();

        expect(mocks.shift).not.toHaveBeenCalled();
        const lastCall = mocks.computePosition.mock.calls.at(-1)!;
        expect(lastCall[2].middleware.map((item) => item.name)).toEqual(['offset', 'flip']);
    });
});
