// @vitest-environment happy-dom

import type Content from '../../../block/base/content';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../../muya';
import { InlineFormatToolbar } from '../index';

// 「标注」是这条格式工具条上的**动作入口**，不是格式：
//   · 同块选区：排在格式按钮末尾，前面插一条 `li.divider`；
//   · 跨块选区：整条工具条只留它一项（跨块时块的 click/keyup 处理器根本不跑，
//     `muya-format-picker` 不会触发，这条订阅是唯一入口）；
//   · 偏好关闭（annotation.enabled=false）或标注模块缺席时：整项消失。
// 另外它必须**不进** `block.format()` / `_formats` 同步逻辑——所以这里同时钉住
// 「点了不调 format」与「跨块下 `_block` 为 null 也不炸」。
//
// 选区端点用真实块（`scrollPage` 里的 `Content`）：`muya-annotation-request`
// 有两个订阅者，引擎侧的标注模块会立刻对快照做 `selectionToRanges()`，块形状不
// 对就会在别人的代码里炸。

const bootedHosts: HTMLElement[] = [];

/** 一个够用的矩形：`getCursorReference()` 只透传它，floating-ui 只读 x/y/宽高。 */
const RECT = { x: 10, y: 20, width: 120, height: 18, top: 20, left: 10, right: 130, bottom: 38 };

beforeEach(() => {
    window.MUYA_VERSION = 'test';
    // baseFloat 用 ResizeObserver 观察容器；happy-dom 不提供，兜一个空实现。
    if (typeof globalThis.ResizeObserver === 'undefined') {
        globalThis.ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as never;
    }
});

afterEach(() => {
    while (bootedHosts.length) bootedHosts.pop()!.remove();
    document.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
});

function bootMuya(markdown = 'first paragraph\n\nsecond paragraph\n'): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    bootedHosts.push(muya.domNode);

    return muya;
}

function realBlocks(muya: Muya): { first: Content; last: Content } {
    const scrollPage = muya.editor.scrollPage!;

    return {
        first: scrollPage.firstContentInDescendant()!,
        last: scrollPage.lastContentInDescendant()!,
    };
}

/** 装上标注模块的桩（`enabled` 即偏好位），返回桩对象便于断言。 */
function stubAnnotationModule(muya: Muya, enabled = true) {
    const module = {
        enabled,
        addFromSnapshot: vi.fn(() => null),
        updateNote: vi.fn(),
        findAtSnapshot: vi.fn(() => null),
    };
    Object.defineProperty(muya.editor, 'annotation', { value: module, configurable: true });

    return module;
}

/** 断言「标注模块还没接上」时的容错。 */
function stubNoAnnotationModule(muya: Muya) {
    Object.defineProperty(muya.editor, 'annotation', { value: undefined, configurable: true });
}

/** 让 `getCursorReference()` 在 happy-dom 里也能拿到一个矩形。 */
function stubDocumentSelection() {
    const range = {
        cloneRange: () => range,
        getClientRects: () => [RECT],
        getBoundingClientRect: () => RECT,
        toString: () => 'first paragraph',
    };
    vi.spyOn(document, 'getSelection').mockReturnValue({
        rangeCount: 1,
        getRangeAt: () => range,
        removeAllRanges: () => {},
        toString: () => 'first paragraph',
    } as unknown as Selection);
}

/** 钉住选区的六个端点 getter + `setSelection` + `getSelection`（实时快照源）。 */
function stubSelection(muya: Muya, sameBlock = true) {
    const { first, last } = realBlocks(muya);
    const anchorBlock = first;
    const focusBlock = sameBlock ? first : last;
    const setSelection = vi.fn();

    Object.entries({
        anchor: { offset: 0, block: anchorBlock, path: anchorBlock.path },
        focus: { offset: 5, block: focusBlock, path: focusBlock.path },
        anchorBlock,
        focusBlock,
        anchorPath: anchorBlock.path,
        focusPath: focusBlock.path,
        isSelectionInSameBlock: sameBlock,
        setSelection,
        // 早返回现在从**实时选区**取快照（getSelection()）；缓存端点保留给格式化路径。
        getSelection: () => ({
            anchor: { offset: 0, block: anchorBlock, path: anchorBlock.path },
            focus: { offset: 5, block: focusBlock, path: focusBlock.path },
            isCollapsed: false,
            isSelectionInSameBlock: sameBlock,
        }),
    }).forEach(([key, value]) => {
        Object.defineProperty(muya.editor.selection, key, { value, configurable: true });
    });

    return { setSelection };
}

function emitSelectionChange(
    muya: Muya,
    extra: { isCollapsed?: boolean; isSelectionInSameBlock?: boolean } = {},
): void {
    muya.eventCenter.emit('selection-change', {
        formats: [],
        isCollapsed: extra.isCollapsed ?? false,
        isSelectionInSameBlock: extra.isSelectionInSameBlock ?? true,
    });
}

function items(toolbar: InlineFormatToolbar): HTMLElement[] {
    return [...toolbar.container!.querySelectorAll<HTMLElement>('li.item')];
}

// `hide()` 只把浮层移出视野，不清空容器（与其它浮层一致），所以收起后要断言的是
// 跨块态与可见性，而不是 DOM。
function isCrossBlock(toolbar: InlineFormatToolbar): boolean {
    return (toolbar as unknown as { _crossBlock: boolean })._crossBlock;
}

function clickItem(toolbar: InlineFormatToolbar, type: string): void {
    const item = toolbar.container!.querySelector<HTMLElement>(`li.item.${type}`);
    expect(item, `missing li.item.${type}`).toBeTruthy();
    item!.dispatchEvent(new Event('click'));
}

/** `_selectItem` 走 `this._block!.format()`，测试里直接替换掉那个块。 */
function stubFormatBlock(toolbar: InlineFormatToolbar): ReturnType<typeof vi.fn> {
    const format = vi.fn();
    Object.defineProperty(toolbar, '_block', {
        value: { getFormatsInRange: () => ({ formats: [] }), format },
        configurable: true,
    });

    return format;
}

describe('inlineFormatToolbar · annotation entry', () => {
    it('appends the annotation action last, behind a divider', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        const toolbar = new InlineFormatToolbar(muya);
        toolbar.status = true;

        emitSelectionChange(muya);

        const all = items(toolbar);
        expect(all).toHaveLength(11);
        expect(all.at(-1)!.classList.contains('annotation')).toBe(true);

        const divider = toolbar.container!.querySelector<HTMLElement>('li.divider');
        expect(divider).toBeTruthy();
        expect(divider!.nextElementSibling!.classList.contains('annotation')).toBe(true);
        // 既有视觉不动：清除格式仍带着它自己的分组竖线。
        expect(toolbar.container!.querySelector('li.item.clear')).toBeTruthy();
    });

    it('drops the action when the preference is off, leaving the formats intact', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya, false);
        const toolbar = new InlineFormatToolbar(muya);
        toolbar.status = true;

        emitSelectionChange(muya);

        expect(toolbar.container!.querySelector('li.item.annotation')).toBeNull();
        expect(toolbar.container!.querySelector('li.divider')).toBeNull();
        expect(toolbar.container!.querySelector('li.item.strong')).toBeTruthy();
        expect(items(toolbar)).toHaveLength(10);
    });

    it('stays inert while no annotation module is registered', () => {
        const muya = bootMuya();
        stubNoAnnotationModule(muya);
        const toolbar = new InlineFormatToolbar(muya);
        toolbar.status = true;

        emitSelectionChange(muya);

        expect(toolbar.container!.querySelector('li.item.annotation')).toBeNull();
        expect(toolbar.container!.querySelector('li.item.strong')).toBeTruthy();
    });
});

describe('inlineFormatToolbar · cross-block channel', () => {
    it('shows the annotation action alone for a cross-block selection', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const toolbar = new InlineFormatToolbar(muya);

        emitSelectionChange(muya, { isSelectionInSameBlock: false });

        expect(toolbar.status).toBe(true);
        expect(items(toolbar)).toHaveLength(1);
        expect(items(toolbar)[0].classList.contains('annotation')).toBe(true);
        expect(toolbar.container!.querySelector('li.item.strong')).toBeNull();
        // 单独一项没有可分组的对象，竖线不出现。
        expect(toolbar.container!.querySelector('li.divider')).toBeNull();
    });

    it('collapses the cross-block render when the selection returns to one block', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const toolbar = new InlineFormatToolbar(muya);

        emitSelectionChange(muya, { isSelectionInSameBlock: false });
        expect(toolbar.status).toBe(true);
        expect(isCrossBlock(toolbar)).toBe(true);

        // 跨块渲染没有 `_block`，留着会让格式按钮点不动（目标为 null）。
        emitSelectionChange(muya);
        expect(toolbar.status).toBe(false);
        expect(isCrossBlock(toolbar)).toBe(false);
    });

    it('collapses it for a collapsed selection and when the preference is off', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const toolbar = new InlineFormatToolbar(muya);

        emitSelectionChange(muya, { isSelectionInSameBlock: false });
        emitSelectionChange(muya, { isSelectionInSameBlock: false, isCollapsed: true });
        expect(toolbar.status).toBe(false);
        expect(isCrossBlock(toolbar)).toBe(false);

        emitSelectionChange(muya, { isSelectionInSameBlock: false });
        expect(toolbar.status).toBe(true);

        stubAnnotationModule(muya, false);
        emitSelectionChange(muya, { isSelectionInSameBlock: false });
        expect(toolbar.status).toBe(false);
        expect(isCrossBlock(toolbar)).toBe(false);
    });
});

describe('inlineFormatToolbar · annotation click path', () => {
    it('restores the selection, emits the snapshot and hides, never formatting', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        const { setSelection } = stubSelection(muya);
        const toolbar = new InlineFormatToolbar(muya);
        toolbar.status = true;
        emitSelectionChange(muya);

        const requests: Array<Record<string, unknown>> = [];
        muya.eventCenter.subscribe('muya-annotation-request', (payload: Record<string, unknown>) => {
            requests.push(payload);
        });

        const format = stubFormatBlock(toolbar);
        clickItem(toolbar, 'annotation');

        expect(requests).toHaveLength(1);
        expect(requests[0].anchor).toMatchObject({ offset: 0 });
        expect(requests[0].focus).toMatchObject({ offset: 5 });
        expect(requests[0].anchorBlock).toBeDefined();
        // 与既有格式化路径同一手法：点击浮层丢 DOM 选区，先还原再取快照。
        expect(setSelection).toHaveBeenCalledTimes(1);
        expect(format).not.toHaveBeenCalled();
        expect(toolbar.status).toBe(false);
    });

    it('is safe from the cross-block channel, where no block is behind the tool', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        stubSelection(muya, false);
        const toolbar = new InlineFormatToolbar(muya);
        emitSelectionChange(muya, { isSelectionInSameBlock: false });

        const requests: unknown[] = [];
        muya.eventCenter.subscribe('muya-annotation-request', payload => requests.push(payload));

        expect(() => clickItem(toolbar, 'annotation')).not.toThrow();
        expect(requests).toHaveLength(1);
        expect(toolbar.status).toBe(false);
    });

    it('keeps the existing format path untouched (contrast)', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubSelection(muya);
        const toolbar = new InlineFormatToolbar(muya);
        toolbar.status = true;
        emitSelectionChange(muya);

        const format = stubFormatBlock(toolbar);
        clickItem(toolbar, 'strong');

        expect(format).toHaveBeenCalledWith('strong');
    });
});
