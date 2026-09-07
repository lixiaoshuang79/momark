// @vitest-environment happy-dom

import type Content from '../../../base/content';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../../../muya';

// `TableCellContent` guards an empty cell against the IME bug where composing
// CJK in an empty contenteditable table cell corrupts the table:
// ① render 层在空单元格预置真实 \u200B 文本节点（非 :empty::after 伪元素），
//    把 Blink 的 IME 组合锚点固定在格内（Chromium 嵌套 contenteditable
//    空组合会把锚点规范化到下一格开头）；
// ② compositionend 后把并入 state 的占位 \u200B 两端剥除（Chromium 提交文本
//    插在占位内→前导；Safari 老路径→尾部），留下干净文本。
// The e2e ime.spec.ts deliberately seeds a NON-empty cell to avoid this
// branch, so the empty-cell path is unit-only.

const ZWSP = '\u200B';

const bootedHosts: HTMLElement[] = [];
let originalVersion: string | undefined;
let hadVersion = false;

beforeEach(() => {
    hadVersion = 'MUYA_VERSION' in window;
    originalVersion = window.MUYA_VERSION;
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedHosts.length) {
        const host = bootedHosts.pop()!;
        host.remove();
    }
    document.getSelection()?.removeAllRanges();
    if (hadVersion)
        window.MUYA_VERSION = originalVersion as string;
    else
        delete (window as Partial<Window>).MUYA_VERSION;
});

function bootMuya(markdown: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    bootedHosts.push(muya.domNode);
    return muya;
}

// Collect the table cell content blocks in document order.
function tableCells(muya: Muya): Content[] {
    const out: Content[] = [];
    const visit = (block: {
        constructor: { blockName?: string };
        children?: { forEach: (cb: (b: unknown) => void) => void };
    }) => {
        if (block.constructor.blockName === 'table.cell.content')
            out.push(block as unknown as Content);
        block.children?.forEach(b => visit(b as typeof block));
    };
    visit(muya.editor.scrollPage as unknown as Parameters<typeof visit>[0]);
    return out;
}

function flush(): Promise<void> {
    return new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

function composeEvent(type: 'compositionstart' | 'compositionend'): Event {
    return { type } as unknown as Event;
}

// `_hasZeroWidthSpaceAtBeginning` is a private flag; the spec reads it to prove
// the guard fired (test files are exempt from muya's strict cast rule).
function zwspFlag(cell: Content): boolean {
    return (cell as unknown as { _hasZeroWidthSpaceAtBeginning: boolean })._hasZeroWidthSpaceAtBeginning;
}

// A table with an empty first header cell and non-empty cells elsewhere.
const TABLE = '|  | b |\n| --- | --- |\n| c | d |\n';

describe('tableCellContent.composeHandler — empty-cell ZWSP guard', () => {
    it('an EMPTY cell renders a real zero-width text node on boot (IME anchor fix)', async () => {
        const muya = bootMuya(TABLE);
        await flush();
        const cell = tableCells(muya)[0];
        expect(cell.text).toBe('');
        // 占位 \u200B 是真实文本节点（非 :empty::after 伪元素），
        // Blink 的 IME 组合锚点因此固定在格内，不会跳到下一格。
        expect(cell.domNode!.textContent).toBe(ZWSP);
        expect(cell.domNode!.childNodes.length).toBe(1);
        expect(cell.domNode!.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    });

    it('compositionstart in an EMPTY cell keeps the placeholder and sets the flag', async () => {
        const muya = bootMuya(TABLE);
        await flush();
        const cell = tableCells(muya)[0];
        expect(cell.text).toBe('');

        muya.editor.activeContentBlock = cell;
        cell.setCursor(0, 0, true);
        cell.composeHandler(composeEvent('compositionstart'));

        expect(cell.domNode!.textContent).toBe(ZWSP);
        expect(zwspFlag(cell)).toBe(true);
    });

    it('compositionstart in a NON-empty cell does NOT seed a zero-width space', async () => {
        const muya = bootMuya(TABLE);
        await flush();
        const cell = tableCells(muya)[1]; // header cell `b`
        expect(cell.text).toBe('b');
        const before = cell.domNode!.textContent;

        muya.editor.activeContentBlock = cell;
        cell.setCursor(1, 1, true);
        cell.composeHandler(composeEvent('compositionstart'));

        expect(cell.domNode!.textContent).not.toContain(ZWSP);
        expect(cell.domNode!.textContent).toBe(before);
        expect(zwspFlag(cell)).toBe(false);
    });

    it('compositionend strips a LEADING seed (Chromium: text committed inside the placeholder)', async () => {
        const muya = bootMuya(TABLE);
        await flush();
        const cell = tableCells(muya)[0];
        muya.editor.activeContentBlock = cell;
        cell.setCursor(0, 0, true);

        // compositionstart seeds the ZWSP and arms the flag.
        cell.composeHandler(composeEvent('compositionstart'));
        expect(zwspFlag(cell)).toBe(true);

        // The browser commits `你好` INSIDE the placeholder text node, then
        // `compositionend`'s base inputHandler syncs the DOM into `this.text`.
        // Isolate the tableCell strip branch: stub inputHandler (covered
        // elsewhere, and depends on real-browser composition).
        vi.spyOn(cell, 'inputHandler').mockImplementation(() => {});
        cell.text = `${ZWSP}你好`;

        cell.composeHandler(composeEvent('compositionend'));
        await flush();

        expect(cell.text).toBe('你好');
        expect(cell.text).not.toContain(ZWSP);
        expect(zwspFlag(cell)).toBe(false);
        const cursor = cell.getCursor();
        expect(cursor).not.toBeNull();
        expect(cursor!.start.offset).toBe('你好'.length);
    });

    it('compositionend also strips a TRAILING seed (Safari legacy path)', async () => {
        const muya = bootMuya(TABLE);
        await flush();
        const cell = tableCells(muya)[0];
        muya.editor.activeContentBlock = cell;
        cell.setCursor(0, 0, true);

        cell.composeHandler(composeEvent('compositionstart'));
        expect(zwspFlag(cell)).toBe(true);

        vi.spyOn(cell, 'inputHandler').mockImplementation(() => {});
        cell.text = `你好${ZWSP}`;

        cell.composeHandler(composeEvent('compositionend'));
        await flush();

        expect(cell.text).toBe('你好');
        expect(cell.text).not.toContain(ZWSP);
        expect(zwspFlag(cell)).toBe(false);
        const cursor = cell.getCursor();
        expect(cursor).not.toBeNull();
        expect(cursor!.start.offset).toBe('你好'.length);
    });
});
