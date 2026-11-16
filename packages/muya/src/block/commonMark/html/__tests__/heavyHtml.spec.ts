// @vitest-environment happy-dom
import type HTMLBlock from '../index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLASS_NAMES } from '../../../../config';
import { Muya } from '../../../../muya';
import { HTML_LITE_MAX_LINE } from '../../../../utils/htmlWeight';

// 墨记 1.6.4 白屏事故的回归护栏：4.4MB PRD 的 HTML 块里有一行 4MB 的
// `<script type="text/plain">` base64 载荷。块内含 <script> → 源码视图的 markup 高亮
// 会把脚本正文按 JavaScript 语法嵌套高亮，Prism 的 function/function-variable 规则在
// 一整段标识符字符上平方级回退（2.5 万字符 1.8s、100 万字符外推 ~50 分钟）。
//
// 修法两层：① 代码高亮预算（长标识符段 / 超长代码不进 Prism）；② 重量 HTML 不内嵌，
// 显示降级卡片。下面三组分别钉住两层修法，以及轻量脚本帧路径不退步。

const bootedHosts: HTMLElement[] = [];
let originalVersion: string | undefined;
let hadVersion = false;

beforeEach(() => {
    hadVersion = 'MUYA_VERSION' in window;
    originalVersion = window.MUYA_VERSION;
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedHosts.length)
        bootedHosts.pop()!.remove();
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

// 与事故文件同形态的载荷：ASCII HTML 的 base64 几乎不含 + /，整行是一段标识符字符。
function base64Payload(length: number): string {
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Prototype</title></head><body><div id="app"></div></body></html>';
    const seed = btoa(html).replace(/[+/=]/g, 'A');

    return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

function scriptBlock(payload: string): string {
    return `<div class="x"><script id="wbSourceData" type="text/plain">${payload}</script><script>render()</script></div>`;
}

const CHART_BLOCK = [
    '<div id="c" style="height:200px"></div>',
    '<script>',
    'document.getElementById("c").textContent = "chart";',
    '</script>',
].join('\n');

function firstFigure(muya: Muya): HTMLElement {
    return muya.domNode.querySelector(`figure.${CLASS_NAMES.MU_HTML_BLOCK}`) as HTMLElement;
}

describe('heavy HTML block (fallback card)', () => {
    it('opens a 1MB script payload quickly and shows the card instead of a frame', () => {
        const payload = base64Payload(1024 * 1024);
        const markdown = `# PRD\n\n${scriptBlock(payload)}\n\nafter\n`;

        const t0 = performance.now();
        const muya = bootMuya(markdown);
        const elapsed = performance.now() - t0;

        // 修复前 1MB 载荷即卡死（不返回）；修复后实测 ~15ms，这里留足 CI 余量。
        expect(elapsed).toBeLessThan(2000);

        const figure = firstFigure(muya);
        expect(figure.classList.contains(CLASS_NAMES.MU_HTML_HEAVY)).toBe(true);
        expect(figure.querySelector(`.${CLASS_NAMES.MU_HTML_HEAVY_CARD}`)).not.toBeNull();
        expect(figure.querySelector('iframe')).toBeNull();
    });

    it('keeps the source byte-for-byte (the card is display only)', () => {
        const payload = base64Payload(HTML_LITE_MAX_LINE + 10);
        const block = scriptBlock(payload);
        const muya = bootMuya(`${block}\n\nafter\n`);

        expect(muya.getMarkdown()).toContain(block);
    });

    it('opens the source side by side from the card', () => {
        const block = scriptBlock(base64Payload(HTML_LITE_MAX_LINE + 10));
        const muya = bootMuya(`${block}\n`);
        const events: Array<{ title: string; html: string }> = [];
        muya.on('muya-html-open-side-by-side', (payload: { title: string; html: string }) => events.push(payload));

        const button = firstFigure(muya).querySelector<HTMLButtonElement>(`.${CLASS_NAMES.MU_HTML_HEAVY_CARD} button`)!;
        button.click();

        expect(events).toHaveLength(1);
        expect(events[0].html).toBe(block);
    });

    it('drops back to an inline frame once the source is trimmed below the limits', () => {
        const muya = bootMuya(`${scriptBlock(base64Payload(HTML_LITE_MAX_LINE + 10))}\n`);
        const htmlBlock = muya.editor.scrollPage!.firstChild as unknown as HTMLBlock;
        const preview = htmlBlock.attachments.head as unknown as { update: (html: string) => void };

        preview.update(CHART_BLOCK);

        const figure = firstFigure(muya);
        expect(figure.classList.contains(CLASS_NAMES.MU_HTML_HEAVY)).toBe(false);
        expect(figure.querySelector(`.${CLASS_NAMES.MU_HTML_HEAVY_CARD}`)).toBeNull();
        expect(figure.querySelector('iframe')).not.toBeNull();
    });
});

describe('code highlight budget on the script-frame path', () => {
    it('does not run Prism over a long identifier run inside a lightweight script block', () => {
        // 5 万字符一段：低于轻量阈值（仍走脚本帧），但修复前光高亮就要 ~7s。
        const payload = base64Payload(50_000);

        const t0 = performance.now();
        const muya = bootMuya(`${scriptBlock(payload)}\n`);
        const elapsed = performance.now() - t0;

        expect(elapsed).toBeLessThan(2000);

        const figure = firstFigure(muya);
        expect(figure.classList.contains(CLASS_NAMES.MU_HTML_HEAVY)).toBe(false);
        expect(figure.querySelector('iframe')).not.toBeNull();
        // 源码视图按纯文本显示：没有 Prism token 节点。
        expect(figure.querySelector('.mu-html-container .token')).toBeNull();
    });
});

describe('lightweight script frame (no regression)', () => {
    it('renders a chart block in the sandboxed bootstrap frame', () => {
        const muya = bootMuya(`${CHART_BLOCK}\n`);
        const figure = firstFigure(muya);
        const frame = figure.querySelector('iframe')!;

        expect(frame).not.toBeNull();
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame.getAttribute('src')!.endsWith('/html-frame.html')).toBe(true);
        expect(figure.classList.contains(CLASS_NAMES.MU_HTML_HEAVY)).toBe(false);
        expect(figure.querySelector(`.${CLASS_NAMES.MU_HTML_HEAVY_CARD}`)).toBeNull();
    });

    it('still syntax-highlights ordinary block source', () => {
        const muya = bootMuya(`${CHART_BLOCK}\n`);

        expect(firstFigure(muya).querySelector('.mu-html-container .token')).not.toBeNull();
    });
});
