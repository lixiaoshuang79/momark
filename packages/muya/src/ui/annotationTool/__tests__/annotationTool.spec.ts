// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../../muya';
import { AnnotationTool } from '../index';

// 备注卡片浮层（`ui/annotationTool`）：工具条点「标注」发事件 → 卡片写备注 →
// 交回引擎。这里钉住五件事：
//   ① 四段结构（头 / chips / 输入框 / 底栏）：引文预览已删、⚙ 在位；
//   ② 空备注禁用保存（方案 §3.6：不允许「只有高亮没有信息」的条目）；
//   ③ 新建走 addFromSnapshot、编辑走 updateNote；保存后走退场动画再关闭；
//   ④ 常用语 chips：点 chip 直接完成标注（手写字合并、一个字不丢）、⌥N 等效、
//      hover 预演 placeholder、「＋ 存为常用语」发事件；
//   ⑤ Esc 取消不写引擎，⌘↵ 空输入框时用第 1 枚常用语落标。

const bootedHosts: HTMLElement[] = [];
const tools: AnnotationTool[] = [];

/** `getCursorReference()` 只透传它，floating-ui 只读 x/y/宽高。 */
const RECT = { x: 10, y: 20, width: 120, height: 18, top: 20, left: 10, right: 130, bottom: 38 };

const DEFAULT_PHRASES = ['看不懂，优化表达', '删掉'];

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
function stubAnnotationModule(
    muya: Muya,
    hit: null | { id: string; note: string } = null,
    phrases: string[] = DEFAULT_PHRASES,
) {
    const module = {
        enabled: true,
        quickPhrases: [...phrases],
        // 返回一个假条目：卡片把 `null`（空选区 / 锚点提取失败）当作保存失败、
        // 不退场——桩要返回成功值，才走得到「已发出保存事件」的链路。
        addFromSnapshot: vi.fn((): { id: string } | null => ({ id: 'new-1' })),
        // `updateNote` 返回布尔（false = 条目已不存在），桩默认保存成功
        updateNote: vi.fn(() => true),
        // 卡片打开期间画「正在标注的选区」（选中态）；桩记下调用即可
        setPendingRanges: vi.fn(),
        findAtSnapshot: vi.fn(() => (hit
            ? { id: hit.id, note: hit.note, anchor: { quote: '' } }
            : null)),
    };
    Object.defineProperty(muya.editor, 'annotation', { value: module, configurable: true });

    return module;
}

function stubNoAnnotationModule(muya: Muya) {
    Object.defineProperty(muya.editor, 'annotation', { value: undefined, configurable: true });
}

function stubDocumentSelection(text = '用户可以在任意页面切换角色') {
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

function hintOf(tool: AnnotationTool): HTMLElement {
    return tool.container!.querySelector<HTMLElement>('.mu-annotation-hint')!;
}

function collectOf(tool: AnnotationTool): HTMLButtonElement {
    return tool.container!.querySelector<HTMLButtonElement>('.mu-annotation-collect')!;
}

function chipsOf(tool: AnnotationTool): HTMLButtonElement[] {
    return [...tool.container!.querySelectorAll<HTMLButtonElement>('.mu-annotation-quick-chip')];
}

/** 卡片退场是动画驱动的：测试里替动画补一记 animationend，把它送进 hide()。 */
function finishLeave(tool: AnnotationTool): void {
    tool.floatBox!.dispatchEvent(new Event('animationend'));
}

function typeAs(note: HTMLTextAreaElement, value: string): void {
    note.value = value;
    note.dispatchEvent(new Event('input'));
}

function press(note: HTMLTextAreaElement, key: string, modifier = false, init: KeyboardEventInit = {}): void {
    note.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        metaKey: modifier,
        bubbles: true,
        cancelable: true,
        ...init,
    }));
}

function clickChip(chip: HTMLButtonElement): void {
    chip.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
}

/** chip 的保存编排有 100ms 的落印停顿，等它走完。 */
function waitChipSave(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 140));
}

describe('annotationTool · 打开与呈现', () => {
    it('opens with the four-part structure and no quote preview', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);

        openCard(muya);

        expect(tool.status).toBe(true);
        expect(tool.container!.querySelector('.mu-annotation-tag')!.textContent).toBe('Annotate');
        // 引文预览已删：引文在正文高亮里，卡片不再重述
        expect(tool.container!.querySelector('.mu-annotation-quote')).toBeNull();
        // ⚙ 管理常用语入口
        expect(tool.container!.querySelector('.mu-annotation-gear')).not.toBeNull();
        expect(noteOf(tool).placeholder).toBe('Write a note, e.g. this logic is wrong');
        expect(noteOf(tool).getAttribute('rows')).toBe('3');
        expect(saveOf(tool).disabled).toBe(true);
    });

    it('renders one chip per quick phrase, with the ⌥N badge', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);

        openCard(muya);

        const chips = chipsOf(tool);
        expect(chips.map(chip => chip.textContent)).toEqual(['看不懂，优化表达⌥1', '删掉⌥2']);
        expect(chips[0].querySelector('.mu-annotation-quick-key')!.textContent).toBe('⌥1');
        expect(chips[0].querySelector('.mu-annotation-quick-fill')).not.toBeNull();
    });

    it('hides the chips row when there are no quick phrases', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya, null, []);
        stubDocumentSelection();
        const tool = makeTool(muya);

        openCard(muya);

        expect(chipsOf(tool)).toHaveLength(0);
        expect(tool.container!.querySelector<HTMLElement>('.mu-annotation-quick')!.hidden).toBe(true);
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

    it('emits the settings event from the gear button', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        const listener = vi.fn();
        muya.eventCenter.subscribe('muya-annotation-settings', listener);

        openCard(muya);
        (tool.container!.querySelector('.mu-annotation-gear') as HTMLButtonElement)
            .dispatchEvent(new Event('click'));

        expect(listener).toHaveBeenCalledTimes(1);
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

    it('saves a new annotation through addFromSnapshot, then closes through the exit animation', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        const snapshot = openCard(muya);
        const saved = vi.fn();
        muya.eventCenter.subscribe('muya-annotation-saved', saved);

        typeAs(noteOf(tool), '  这段逻辑不通  ');
        vi.spyOn(saveOf(tool), 'getBoundingClientRect').mockReturnValue({
            ...RECT,
            x: 40,
            y: 60,
            left: 40,
            top: 60,
            right: 60,
            bottom: 76,
            width: 20,
            height: 16,
        } as DOMRect);
        saveOf(tool).dispatchEvent(new Event('click'));

        expect(module.addFromSnapshot).toHaveBeenCalledTimes(1);
        expect(module.addFromSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            anchorBlock: snapshot.anchorBlock,
        }), '这段逻辑不通');
        expect(module.updateNote).not.toHaveBeenCalled();
        expect(saved).toHaveBeenCalledWith({ origin: { x: 50, y: 68 }, mode: 'manual' });
        // 退场动画在途：此刻还没真正关闭
        expect(tool.status).toBe(true);

        finishLeave(tool);
        expect(tool.status).toBe(false);
    });

    it('keeps the card open and shows a failure hint when the anchor cannot be created', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        // 空选区 / 锚点提取失败时真实模块返回 null
        module.addFromSnapshot.mockReturnValue(null);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);
        const saved = vi.fn();
        muya.eventCenter.subscribe('muya-annotation-saved', saved);

        typeAs(noteOf(tool), '这段逻辑不通');
        saveOf(tool).dispatchEvent(new Event('click'));

        // 不退场、不发保存事件（否则飞点照播、卡片收场，用户写的字静默消失）
        expect(saved).not.toHaveBeenCalled();
        expect(tool.status).toBe(true);
        expect(noteOf(tool).value).toBe('这段逻辑不通');
        expect(hintOf(tool).querySelector('[data-hint="failed"]')!.classList.contains('on')).toBe(true);
    });

    it('ignores a second submit during the exit animation', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);
        typeAs(noteOf(tool), '这段逻辑不通');

        saveOf(tool).dispatchEvent(new Event('click'));
        expect(module.addFromSnapshot).toHaveBeenCalledTimes(1);

        // 退场在途再按一次 ⌘↵：同一个选区不得落下第二条标注
        press(noteOf(tool), 'Enter', true);
        expect(module.addFromSnapshot).toHaveBeenCalledTimes(1);
    });

    it('opens in edit mode and updates the existing note', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya, { id: 'a1', note: '旧备注' });
        stubDocumentSelection();
        const tool = makeTool(muya);

        openCard(muya);

        expect(tool.container!.querySelector('.mu-annotation-tag')!.textContent).toBe('Annotate · Edit');
        const note = noteOf(tool);
        expect(note.value).toBe('旧备注');

        typeAs(note, '改成这句');
        saveOf(tool).dispatchEvent(new Event('click'));

        expect(module.updateNote).toHaveBeenCalledWith('a1', '改成这句');
        expect(module.addFromSnapshot).not.toHaveBeenCalled();

        finishLeave(tool);
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

        finishLeave(tool);
        expect(tool.status).toBe(false);
    });

    it('uses the first quick phrase when ⌘↵ is pressed on an empty note', async () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        typeAs(noteOf(tool), '   ');
        press(noteOf(tool), 'Enter', true);

        // 这里走的是 chip 主路径（含 100ms 落印停顿），不是直接保存
        expect(module.addFromSnapshot).not.toHaveBeenCalled();
        expect(chipsOf(tool)[0].classList.contains('stamp')).toBe(true);

        await waitChipSave();
        expect(module.addFromSnapshot).toHaveBeenCalledWith(expect.anything(), '看不懂，优化表达');
    });

    it('does nothing on ⌘↵ with an empty note when there are no quick phrases', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya, null, []);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        typeAs(noteOf(tool), '   ');
        press(noteOf(tool), 'Enter', true);

        expect(module.addFromSnapshot).not.toHaveBeenCalled();
        expect(tool.status).toBe(true);
    });

    it('does not save an empty note through the save button', () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        saveOf(tool).dispatchEvent(new Event('click'));

        expect(module.addFromSnapshot).not.toHaveBeenCalled();
        expect(tool.status).toBe(true);
    });
});

describe('annotationTool · 常用语 chips', () => {
    it('saves with the chip phrase directly on click', async () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        const snapshot = openCard(muya);
        const saved = vi.fn();
        muya.eventCenter.subscribe('muya-annotation-saved', saved);

        clickChip(chipsOf(tool)[1]);

        expect(module.addFromSnapshot).not.toHaveBeenCalled();

        await waitChipSave();

        expect(module.addFromSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            anchorBlock: snapshot.anchorBlock,
        }), '删掉');
        expect(saved).toHaveBeenCalledWith(expect.objectContaining({ mode: 'chip' }));
    });

    it('merges the typed note with the chip phrase, never dropping the typed text', async () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        typeAs(noteOf(tool), '这段逻辑不通');
        clickChip(chipsOf(tool)[0]);

        await waitChipSave();

        expect(module.addFromSnapshot).toHaveBeenCalledWith(expect.anything(), '这段逻辑不通\n看不懂，优化表达');
    });

    it('treats ⌥N as a click on the Nth chip', async () => {
        const muya = bootMuya();
        const module = stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        press(noteOf(tool), '¡', false, { code: 'Digit2', altKey: true });

        await waitChipSave();

        expect(module.addFromSnapshot).toHaveBeenCalledWith(expect.anything(), '删掉');
    });

    it('previews the phrase in the placeholder while hovering an empty note', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        const chip = chipsOf(tool)[0];
        chip.dispatchEvent(new Event('mouseenter'));
        expect(noteOf(tool).placeholder).toBe('看不懂，优化表达');
        expect(hintOf(tool).querySelector('[data-hint="hover"]')!.classList.contains('on')).toBe(true);

        chip.dispatchEvent(new Event('mouseleave'));
        expect(noteOf(tool).placeholder).toBe('Write a note, e.g. this logic is wrong');
        expect(hintOf(tool).querySelector('[data-hint="default"]')!.classList.contains('on')).toBe(true);
    });

    it('refreshes the chips when the phrases change and animates the newborn chip', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);

        muya.eventCenter.emit('annotation-quick-phrases-change', ['看不懂，优化表达', '删掉', '新短语']);

        const chips = chipsOf(tool);
        expect(chips).toHaveLength(3);
        expect(chips[2].textContent).toBe('新短语⌥3');
        expect(chips[2].classList.contains('born')).toBe(true);
        expect(chips[0].classList.contains('born')).toBe(false);
    });

    it('offers 「＋ Save as quick phrase」 for a collectable note and emits the add event', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        const added = vi.fn();
        muya.eventCenter.subscribe('muya-annotation-phrase-add', added);
        openCard(muya);

        expect(collectOf(tool).hidden).toBe(true);
        expect(hintOf(tool).hidden).toBe(false);

        typeAs(noteOf(tool), '  补一个字段  ');
        expect(collectOf(tool).hidden).toBe(false);
        // 提示位让给「＋ 存为常用语」（互斥显示）
        expect(hintOf(tool).hidden).toBe(true);

        collectOf(tool).dispatchEvent(new Event('click'));

        expect(added).toHaveBeenCalledWith({ phrase: '补一个字段' });
        // 乐观切回提示位并闪「已加入 · ⌥3」
        expect(hintOf(tool).hidden).toBe(false);
        expect(hintOf(tool).querySelector('[data-hint="saved"]')!.textContent).toBe('Added · ⌥3');
        expect(hintOf(tool).querySelector('[data-hint="saved"]')!.classList.contains('on')).toBe(true);
    });

    it('keeps undo inside the note textarea', () => {
        const muya = bootMuya();
        stubAnnotationModule(muya);
        stubDocumentSelection();
        const tool = makeTool(muya);
        openCard(muya);
        // happy-dom 没实现 execCommand：注入一枚桩，验证拦截后的唯一出口
        const execCommand = vi.fn(() => true);
        Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true });
        const note = noteOf(tool);

        press(note, 'z', true);

        expect(execCommand).toHaveBeenCalledWith('undo');

        press(note, 'z', true, { shiftKey: true });
        expect(execCommand).toHaveBeenCalledWith('redo');
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
        // 高度按 border-box 写，min/max 要含上下 padding 与边框——少了这一项
        // 「10 行封顶」实际会在 9 行出头就冒出滚动条。
        const cs = getComputedStyle(note);
        const chrome
            = (Number.parseFloat(cs.paddingTop) || 0)
                + (Number.parseFloat(cs.paddingBottom) || 0)
                + (Number.parseFloat(cs.borderTopWidth) || 0)
                + (Number.parseFloat(cs.borderBottomWidth) || 0);

        // happy-dom 没有布局，scrollHeight 只能手工钉。
        const scrollHeight = vi.spyOn(note, 'scrollHeight', 'get');

        scrollHeight.mockReturnValue(0);
        typeAs(note, 'x');
        // 起始 3 行（happy-dom 会把浮点结果序列化，按数值比）
        expect(Number.parseFloat(note.style.height)).toBeCloseTo(lineHeight * 3 + chrome, 5);
        expect(note.style.overflowY).toBe('hidden');

        scrollHeight.mockReturnValue(100);
        typeAs(note, 'x'.repeat(8));
        expect(note.style.height).toBe('100px');
        expect(note.style.overflowY).toBe('hidden');

        scrollHeight.mockReturnValue(5000);
        typeAs(note, 'x'.repeat(400));
        expect(Number.parseFloat(note.style.height)).toBeCloseTo(lineHeight * 10 + chrome, 5);
        // 封顶之后改为内部滚动，卡片本身不再长高。
        expect(note.style.overflowY).toBe('auto');
    });
});
