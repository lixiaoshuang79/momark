// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import type HTMLBlock from '../index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../../../muya';

// happy-dom 下 DOMPurify 会把 iframe 占位的 `<span>` 包装剥掉（Chromium 里不会），
// 预览里恢复不出 iframe。这里只验证 disableHtml 的开关语义，净化本身换成原样透传。
vi.mock('../../../../utils', async importOriginal => ({
    ...await importOriginal<typeof import('../../../../utils')>(),
    sanitize: (html: string) => html,
}));

// 关闭 HTML 渲染（`disableHtml`，桌面「极速模式」也走它）时预览挂件整个不建：
// 不净化、不进 img、不恢复 iframe、不挂脚本沙箱帧，只显示源码。运行时切换走
// 就地刷新——只动 HTML 块，不重建整棵块树。
const IMG_BLOCK = '<div><img src="https://example.com/pic.png"></div>';
const IFRAME_BLOCK = '<iframe src="https://example.com/embed/x" style="width:100%;height:200px"></iframe>';
const SCRIPT_BLOCK = '<div id="a">hi</div><script>document.getElementById("a").textContent = "1";</script>';
const MARKDOWN = `${IMG_BLOCK}\n\n${IFRAME_BLOCK}\n\n${SCRIPT_BLOCK}\n\nafter\n`;

const hosts: HTMLElement[] = [];

beforeEach(() => {
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (hosts.length)
        hosts.pop()!.remove();
});

function boot(markdown: string, disableHtml: boolean): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown, disableHtml } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    hosts.push(muya.domNode);

    return muya;
}

function previews(muya: Muya): HTMLElement[] {
    return [...muya.domNode.querySelectorAll<HTMLElement>('.mu-html-preview')];
}

function figures(muya: Muya): HTMLElement[] {
    return [...muya.domNode.querySelectorAll<HTMLElement>('figure.mu-html-block')];
}

function htmlBlocks(muya: Muya): HTMLBlock[] {
    const blocks: HTMLBlock[] = [];
    muya.editor.scrollPage!.depthFirstTraverse((node) => {
        if (node.blockName === 'html-block')
            blocks.push(node as HTMLBlock);
    });

    return blocks;
}

function expectNothingRendered(muya: Muya) {
    expect(previews(muya).length).toBeGreaterThan(0);
    for (const preview of previews(muya)) {
        expect(preview.querySelector('img')).toBeNull();
        expect(preview.querySelector('iframe')).toBeNull();
        expect(preview.querySelector('.mu-html-frame')).toBeNull();
        expect(preview.innerHTML).toBe('');
    }
    for (const figure of figures(muya))
        expect(figure.classList.contains('mu-disable-html-render')).toBe(true);
}

describe('disableHtml: html-preview renders nothing', () => {
    it('builds no img / iframe / script frame when booted with disableHtml', () => {
        const muya = boot(MARKDOWN, true);

        expect(figures(muya)).toHaveLength(3);
        expectNothingRendered(muya);
        expect(muya.domNode.querySelector('iframe')).toBeNull();
        expect(muya.domNode.querySelector('img')).toBeNull();
        // 源码仍在：容器里有原文，序列化原样往返。
        expect(muya.domNode.textContent).toContain('https://example.com/embed/x');
        expect(muya.getMarkdown()).toBe(MARKDOWN);
    });
});

describe('setOptions({ disableHtml }) refreshes html blocks in place', () => {
    it('drops and restores previews without rebuilding the block tree', () => {
        const muya = boot(MARKDOWN, false);
        const [imgPreview, iframePreview, scriptPreview] = previews(muya);

        expect(imgPreview.querySelector('img')).not.toBeNull();
        expect(iframePreview.querySelector('iframe.mu-html-iframe')).not.toBeNull();
        expect(scriptPreview.querySelector('.mu-html-frame iframe')).not.toBeNull();

        const figuresBefore = figures(muya);
        const firstParagraph = muya.domNode.querySelector('p');

        muya.setOptions({ disableHtml: true });

        expectNothingRendered(muya);
        // 同一批 DOM 节点：只就地刷新，没有整树重建。
        expect(figures(muya)).toEqual(figuresBefore);
        figures(muya).forEach((figure, i) => expect(figure).toBe(figuresBefore[i]));
        expect(muya.domNode.querySelector('p')).toBe(firstParagraph);
        expect(muya.getMarkdown()).toBe(MARKDOWN);

        muya.setOptions({ disableHtml: false });

        const [imgAgain, iframeAgain, scriptAgain] = previews(muya);
        expect(imgAgain.querySelector('img')?.getAttribute('src')).toBe('https://example.com/pic.png');
        expect(iframeAgain.querySelector('iframe.mu-html-iframe')?.getAttribute('src')).toBe('https://example.com/embed/x');
        expect(scriptAgain.querySelector('.mu-html-frame iframe')).not.toBeNull();
        for (const figure of figures(muya))
            expect(figure.classList.contains('mu-disable-html-render')).toBe(false);
        figures(muya).forEach((figure, i) => expect(figure).toBe(figuresBefore[i]));
    });

    it('keeps the block class list in sync with the DOM class', () => {
        const muya = boot(IMG_BLOCK, false);
        const [block] = htmlBlocks(muya);

        muya.setOptions({ disableHtml: true });
        expect(block.classList).toContain('mu-disable-html-render');

        muya.setOptions({ disableHtml: false });
        expect(block.classList).not.toContain('mu-disable-html-render');
    });

    it('refreshes html blocks nested in list items', () => {
        const markdown = `- item\n\n  ${IFRAME_BLOCK}\n`;
        const muya = boot(markdown, false);

        expect(muya.domNode.querySelector('li .mu-html-preview iframe')).not.toBeNull();

        muya.setOptions({ disableHtml: true });

        expect(muya.domNode.querySelector('li figure.mu-html-block.mu-disable-html-render')).not.toBeNull();
        expect(muya.domNode.querySelector('li .mu-html-preview iframe')).toBeNull();

        muya.setOptions({ disableHtml: false });

        expect(muya.domNode.querySelector('li .mu-html-preview iframe')).not.toBeNull();
    });

    it('does not refresh when the value does not change', () => {
        const muya = boot(MARKDOWN, false);
        const spies = htmlBlocks(muya).map(block => vi.spyOn(block, 'refreshRenderMode'));

        muya.setOptions({ disableHtml: false });
        muya.setOptions({ fontSize: 18 });
        for (const spy of spies)
            expect(spy).not.toHaveBeenCalled();

        muya.setOptions({ disableHtml: true });
        muya.setOptions({ disableHtml: true });
        for (const spy of spies)
            expect(spy).toHaveBeenCalledTimes(1);
    });

    it('keeps rendering nothing while the source is edited under disableHtml', () => {
        const muya = boot(IMG_BLOCK, true);
        const [block] = htmlBlocks(muya);
        const preview = block.attachments.head as unknown as { update: (html: string) => void };

        preview.update(IFRAME_BLOCK);
        expectNothingRendered(muya);

        // 重新开启时按最新源码渲染（预览记住了编辑后的源码）。
        muya.setOptions({ disableHtml: false });
        expect(previews(muya)[0].querySelector('iframe.mu-html-iframe')).not.toBeNull();
    });
});
