// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../../muya';
import { AnnotationTool } from '../index';

// 备注卡片浮层（`ui/annotationTool`）：工具条点「标注」发事件 → 卡片写备注 →
// 交回引擎。这里钉住四件事：
//   ① 头部引文单行预览（40 字截断、全文进 title）；
//   ② 空备注禁用保存（方案 §3.6：不允许「只有高亮没有信息」的条目）；
//   ③ 新建走 addFromSnapshot、编辑走 updateNote，保存后关闭；
//   ④ Esc 取消不写引擎，⌘↵ 保存。

const bootedHosts: HTMLElement[] = [];
const tools: AnnotationTool[] = [];

/** `getCursorReference()` 只透传它，floating-ui 只读 x/y/宽高。 */
const RECT = { x: 10, y: 20, width: 120, height: 18, top: 20, left: 10, right: 130, bottom: 38 };

const LONG_QUOTE
    = '用户可以在任意页面切换角色，系统根据当前角色实时刷新权限，这句话里的角色其实不该由用户自己切换。';

beforeEach(() => {
    window.MUYA_VERSION = 'test';
    if (typeof globalThis.ResizeObserver === 'undefined') {
        globalThis.ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as never;
    }
});

afterEach(() => {
    // 卡片里排了「右栏动画结束后重新贴边」的定时器，销毁实例才能清掉。
    while (tools.length) tools.pop()!.destroy();
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

function makeTool(muya: Muya): AnnotationTool {
    const tool = new AnnotationTool(muya);
    tools.push(tool);

    return tool;
}

/** 标注模块的桩；`hit` 非空即卡片走编辑态。 */
function stubAnnotationModule(muya: Muya, hit: null | { id: string; note: string; quote?: string } = null) {
    const module = {
        enabled: true,
        addFromSnapshot: vi.fn(() => null),
        updateNote: vi.fn(),
        findAtSnapshot: vi.fn(() => (hit
            ? { id: hit.id, note: hit.note, anchor: { quote: hit.quote ?? '' } }
            : null)),
    };
    Object.defineProperty(muya.editor, 'annotation', { value: module, configurable: true });

    return module;
}

function stubNoAnnotationModule(muya: Muya) {
    Object.defineProperty(muya.editor, 'annotation', { value: undefined, configurable: true });
}

function stubDocumentSelection(text = LONG_QUOTE) {
    const range = {
        cloneRange: () => range,
        getClientRects: () => [RECT],
        getBoundingClientRect: () => RECT,
        toString: () => text,
    };
    vi.spyOn(document, 'getSelection').mockReturnValue({
        rangeCount: 1,
        getRangeAt: () => range,
        removeAllRanges: () => {},
        toString: () => text,
    } as unknown as Selection);
}

/** 打开卡片：快照用真实块（工具条在生产里也是这么发的）。 */
function openCard(muya: Muya) {
    const first = muya.editor.scrollPage!.firstContentInDescendant()!;
    const snapshot = {
        anchor: { offset: 0, block: first, path: first.path },
        focus: { offset: 5, block: first, path: first.path },
        anchorBlock: first,
        focusBlock: first,
        anchorPath: first.path,
        focusPath: first.path,
    };
    muya.eventCenter.emit('muya-annotation-request', snapshot);

    return snapshot;
}

function noteOf(tool: AnnotationTool): HTMLTextAreaElement {
    return tool.container!.querySelector<HTMLTextAreaElement>('textarea.mu-annotation-note')!;
}

function saveOf(tool: AnnotationTool): HTMLButtonElement {
    return tool.container!.querySelector<HTMLButtonElement>('.mu-annotation-btn.primary')!;
}

function typeAs(note: HTMLTextAreaElement, value: string): void {
    note.value = value;
    note.dispatchEvent(new Event('input'));
}

function press(note: HTMLTextAreaElement, key: string, modifier = false): void {
    note.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        metaKey: modifier,
        bubbles: true,
        cancelable: true,
    }));
}

describe('annotationTool · 打开与呈现', () => {
    it('opens on the toolbar request with a one-line quote preview', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);

        openCard(muya);

        expect(tool.status).toBe(true);
        const tag = tool.container!.querySelector('.mu-annotation-tag')!;
        const quote = tool.container!.querySelector<HTMLElement>('.mu-annotation-quote')!;
        expect(tag.textContent).toBe('Annotate');
        expect(quote.textContent).toBe(`${LONG_QUOTE.slice(0, 40)}…`);
        // 省略的是显示，全文在 title 里。
        expect(quote.getAttribute('title')).toBe(LONG_QUOTE);
        expect(noteOf(tool).placeholder).toBe('Write a note, e.g. this logic is wrong');
        expect(saveOf(tool).disabled).toBe(true);
    });

    it('stays inert while no annotation module is registered', () => {
        const muya = bootMuya();
        stubNoAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);

        openCard(muya);

        expect(tool.status).toBe(false);
        expect(tool.container!.querySelector('.mu-annotation-note')).toBeNull();
    });

    it('keeps a short quote as-is', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection('这里要补一个字段：生效时间');
        const tool = makeTool(muya);

        openCard(muya);

        const quote = tool.container!.querySelector<HTMLElement>('.mu-annotation-quote')!;
        expect(quote.textContent).toBe('这里要补一个字段：生效时间');
        expect(quote.textContent).not.toContain('…');
    });
});

describe('annotationTool · 保存与取消', () => {
    it('enables save only for a non-empty note', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        typeAs(noteOf(tool), '   ');
        expect(saveOf(tool).disabled).toBe(true);

        typeAs(noteOf(tool), '这段逻辑不通');
        expect(saveOf(tool).disabled).toBe(false);
    });

    it('saves a new annotation through addFromSnapshot and closes', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        const snapshot = openCard(muya);

        typeAs(noteOf(tool), '  这段逻辑不通  ');
        saveOf(tool).dispatchEvent(new Event('click'));

        expect(module.addFromSnapshot).toHaveBeenCalledTimes(1);
        expect(module.addFromSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            anchorBlock: snapshot.anchorBlock,
        }), '这段逻辑不通');
        expect(module.updateNote).not.toHaveBeenCalled();
        expect(tool.status).toBe(false);
    });

    it('opens in edit mode and updates the existing note', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya, { id: 'a1', note: '旧备注', quote: '旧的引文' });
        stubDocumentSelection();
        const tool = makeTool(muya);

        openCard(muya);

        expect(tool.container!.querySelector('.mu-annotation-tag')!.textContent).toBe('Annotate · Edit');
        expect(tool.container!.querySelector<HTMLElement>('.mu-annotation-quote')!.textContent).toBe('旧的引文');
        const note = noteOf(tool);
        expect(note.value).toBe('旧备注');

        typeAs(note, '改成这句');
        saveOf(tool).dispatchEvent(new Event('click'));

        expect(module.updateNote).toHaveBeenCalledWith('a1', '改成这句');
        expect(module.addFromSnapshot).not.toHaveBeenCalled();
        expect(tool.status).toBe(false);
    });

    it('saves with ⌘↵', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        typeAs(noteOf(tool), '补一个字段');
        press(noteOf(tool), 'Enter', true);

        expect(module.addFromSnapshot).toHaveBeenCalledTimes(1);
        expect(tool.status).toBe(false);
    });

    it('cancels with Esc without touching the engine', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        typeAs(noteOf(tool), '写了一半又不想写了');
        press(noteOf(tool), 'Escape');

        expect(module.addFromSnapshot).not.toHaveBeenCalled();
        expect(module.updateNote).not.toHaveBeenCalled();
        expect(tool.status).toBe(false);
    });

    it('does not save an empty note through ⌘↵', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        typeAs(noteOf(tool), '   ');
        press(noteOf(tool), 'Enter', true);

        expect(module.addFromSnapshot).not.toHaveBeenCalled();
        expect(tool.status).toBe(true);
    });
});

describe('annotationTool · 备注框高度自适应', () => {
    it('grows with the content and caps at ten lines', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        const note = noteOf(tool);
        // 与实现同口径：无单位/拿不到的行高按 13px × 1.6 兜底（happy-dom 返回 "1.6"）。
        const computed = Number.parseFloat(getComputedStyle(note).lineHeight);
        const lineHeight = Number.isFinite(computed) && computed >= 8 ? computed : 20.8;

        // happy-dom 没有布局，scrollHeight 只能手工钉。
        const scrollHeight = vi.spyOn(note, 'scrollHeight', 'get');

        scrollHeight.mockReturnValue(0);
        typeAs(note, 'x');
        expect(note.style.height).toBe(`${lineHeight * 2}px`);
        expect(note.style.overflowY).toBe('hidden');

        scrollHeight.mockReturnValue(100);
        typeAs(note, 'x'.repeat(8));
        expect(note.style.height).toBe('100px');
        expect(note.style.overflowY).toBe('hidden');

        scrollHeight.mockReturnValue(5000);
        typeAs(note, 'x'.repeat(400));
        expect(note.style.height).toBe(`${lineHeight * 10}px`);
        // 封顶之后改为内部滚动，卡片本身不再长高。
        expect(note.style.overflowY).toBe('auto');
    });
});
