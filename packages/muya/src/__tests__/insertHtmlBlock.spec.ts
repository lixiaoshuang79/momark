// @vitest-environment happy-dom

import type Content from '../block/base/content';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../muya';

// `insertHtmlBlock` 是「把 html 文件内嵌进文档」落地的那个 API：在光标块之后插入一个
// html-block 状态。这里钉住两件事：①插入的源码逐行原样写回 markdown（作者源码不被改写）；
// ②写出的 markdown 重新解析回来仍是同一个 html 块（存盘/重开不丢，也就是「单文件可带走」）。

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
    if (hadVersion)
        window.MUYA_VERSION = originalVersion as string;
    else
        delete (window as Partial<Window>).MUYA_VERSION;
});

function bootMuya(markdown: string, options: Partial<ConstructorParameters<typeof Muya>[1]> = {}): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown, ...options } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    bootedHosts.push(muya.domNode);
    return muya;
}

function placeCursorOnFirstBlock(muya: Muya): Content {
    const first = muya.editor.scrollPage!.firstContentInDescendant()!;
    muya.editor.activeContentBlock = first;
    first.setCursor(0, 0, true);
    return first;
}

const SAMPLE = [
    '<html><head><style>#bar{background:tomato}</style></head>',
    '<body><div id="bar"></div>',
    '<script>document.title = "内联脚本"</script>',
    '</body></html>',
].join('\n');

describe('insertHtmlBlock', () => {
    it('在光标块之后插入 html 块，并逐行原样写回 markdown', async () => {
        const muya = bootMuya('前面一段\n');
        placeCursorOnFirstBlock(muya);

        muya.insertHtmlBlock(SAMPLE);

        await vi.waitFor(() => {
            const md = muya.getMarkdown();
            expect(md).toContain('<div id="bar"></div>');
            expect(md).toContain('<script>document.title = "内联脚本"</script>');
        });

        // 作者源码不被改写：插入内容里的每一行都在 markdown 里原样存在
        const md = muya.getMarkdown();
        for (const line of SAMPLE.split('\n'))
            expect(md).toContain(line);

        // 前面那段仍然在，且 html 块排在它后面
        expect(md.indexOf('前面一段')).toBeLessThan(md.indexOf('<div id="bar"></div>'));
    });

    it('写出的 markdown 重新解析回来仍是 html 块（存盘后重开不丢）', async () => {
        const muya = bootMuya('前面一段\n');
        placeCursorOnFirstBlock(muya);
        muya.insertHtmlBlock(SAMPLE);

        let markdown = '';
        await vi.waitFor(() => {
            markdown = muya.getMarkdown();
            expect(markdown).toContain('<div id="bar"></div>');
        });

        // 用同一份 markdown 重新启动一个实例：html 块必须还在（不是只存在于内存里的 DOM）
        const reopened = bootMuya(markdown);
        const states = reopened.getState();
        const htmlStates = states.filter(state => state.name === 'html-block');
        expect(htmlStates).toHaveLength(1);
        expect((htmlStates[0] as { text: string }).text).toContain('<div id="bar"></div>');
    });

    // 这条钉住「为什么内联器要剥掉 doctype / 压掉空行」：声明型 html 块在第一个 `>`
    // 处结束、空行会终止 html 块，两者都会把一个块切成两个，重开时脚本块只剩半页。
    it('带 doctype 的整篇文档会被拆成两个 html 块（故内联时须剥掉 doctype）', async () => {
        const muya = bootMuya(`${'<!DOCTYPE html>'}\n${SAMPLE}`);

        const htmlStates = muya.getState().filter(state => state.name === 'html-block');
        expect(htmlStates.length).toBeGreaterThan(1);
    });

    it('空内容不插入（不留下空块）', async () => {
        const muya = bootMuya('前面一段\n');
        placeCursorOnFirstBlock(muya);
        const before = muya.getState().length;

        muya.insertHtmlBlock('   \n  ');

        expect(muya.getState().length).toBe(before);
    });

    it('insertMarkdownLink 在光标处插入 [文字](url)', async () => {
        const muya = bootMuya('看这里\n');
        placeCursorOnFirstBlock(muya);

        const inserted = muya.insertMarkdownLink({ text: 'widget.html', url: 'https://example.com/a.html' });

        expect(inserted).toBe('[widget.html](https://example.com/a.html)');
        await vi.waitFor(() => {
            expect(muya.getMarkdown()).toContain('[widget.html](https://example.com/a.html)');
        });
    });

    it('insertMarkdownLink 没有 url 时不做任何事', async () => {
        const muya = bootMuya('看这里\n');
        placeCursorOnFirstBlock(muya);

        expect(muya.insertMarkdownLink({ text: 'x', url: '' })).toBe('');
        expect(muya.getMarkdown().trim()).toBe('看这里');
    });
});
