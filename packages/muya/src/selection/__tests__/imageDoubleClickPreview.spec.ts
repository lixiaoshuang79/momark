// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLASS_NAMES } from '../../config';
import { Muya } from '../../muya';

// Double-clicking an inline image opens the host's full-screen viewer through
// the same `preview-image` event Space uses. Table-cell images included — that
// is the case users hit in PRD-style documents, where screenshots live in
// table cells rather than standalone paragraphs.

const bootedMuyas: Muya[] = [];

beforeEach(() => {
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedMuyas.length)
        bootedMuyas.pop()!.destroy();
    delete (window as Partial<Window>).MUYA_VERSION;
});

function boot(markdown: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    bootedMuyas.push(muya);
    return muya;
}

// The async image load never resolves under happy-dom, so inject the <img> the
// loaded path would have produced.
function injectImg(wrapper: HTMLElement, src: string): HTMLImageElement {
    const container = wrapper.querySelector<HTMLElement>(
        `.${CLASS_NAMES.MU_IMAGE_CONTAINER}`,
    )!;
    const img = document.createElement('img');
    img.setAttribute('src', src);
    container.appendChild(img);
    return img;
}

function doubleClick(target: Element): void {
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}

function capturePreview(muya: Muya): unknown[] {
    const calls: unknown[] = [];
    muya.on('preview-image', (payload: unknown) => calls.push(payload));
    return calls;
}

describe('double-click previews an inline image', () => {
    it('emits preview-image with the rendered src', () => {
        const src = 'https://example.com/pic.png';
        const muya = boot(`![alt](${src})`);
        const wrapper = muya.domNode.querySelector<HTMLElement>(
            `span.${CLASS_NAMES.MU_INLINE_IMAGE}`,
        )!;
        const img = injectImg(wrapper, src);
        const calls = capturePreview(muya);

        doubleClick(img);

        expect(calls).toEqual([{ data: src }]);
    });

    it('works for an image inside a table cell', () => {
        const src = 'https://example.com/table-pic.png';
        const muya = boot(`| a | b |\n| --- | --- |\n| ![alt](${src}) | x |\n`);
        const wrapper = muya.domNode.querySelector<HTMLElement>(
            `.mu-table-cell span.${CLASS_NAMES.MU_INLINE_IMAGE}`,
        )!;
        expect(wrapper).not.toBeNull();
        const img = injectImg(wrapper, src);
        const calls = capturePreview(muya);

        doubleClick(img);

        expect(calls).toEqual([{ data: src }]);
    });

    it('does not preview a linked image (the click already follows the link)', () => {
        const src = 'https://example.com/pic.png';
        const muya = boot(`[![alt](${src})](https://link.example.com)`);
        const wrapper = muya.domNode.querySelector<HTMLElement>(
            `span.${CLASS_NAMES.MU_INLINE_IMAGE}`,
        )!;
        expect(wrapper.closest(`.${CLASS_NAMES.MU_LINK}`)).not.toBeNull();
        const img = injectImg(wrapper, src);
        const calls = capturePreview(muya);

        doubleClick(img);

        expect(calls).toEqual([]);
    });

    it('works for an image inside an HTML block preview', () => {
        const src = 'https://example.com/html-table.png';
        const htmlTable
            = '<table style="width:100%;table-layout:fixed;"><tr>'
            + `<td style="padding:4px;"><img src="${src}" width="100%"></td>`
            + '</tr></table>';
        const muya = boot(`${htmlTable}\n`);
        const img = muya.domNode.querySelector<HTMLImageElement>(
            `.${CLASS_NAMES.MU_HTML_PREVIEW} img`,
        );
        expect(img).not.toBeNull();
        const calls = capturePreview(muya);

        doubleClick(img!);

        expect(calls).toEqual([{ data: src }]);
    });

    it('does not preview a linked image inside an HTML block', () => {
        const src = 'https://example.com/pic.png';
        const muya = boot(`<div><a href="https://example.com/"><img src="${src}"></a></div>\n`);
        const img = muya.domNode.querySelector<HTMLImageElement>(
            `.${CLASS_NAMES.MU_HTML_PREVIEW} img`,
        );
        expect(img).not.toBeNull();
        const calls = capturePreview(muya);

        doubleClick(img!);

        expect(calls).toEqual([]);
    });

    it('does not preview on a single click', () => {
        const src = 'https://example.com/pic.png';
        const muya = boot(`![alt](${src})`);
        const wrapper = muya.domNode.querySelector<HTMLElement>(
            `span.${CLASS_NAMES.MU_INLINE_IMAGE}`,
        )!;
        const img = injectImg(wrapper, src);
        const calls = capturePreview(muya);

        img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(calls).toEqual([]);
    });

    it('ignores double-clicks on ordinary text', () => {
        const muya = boot('plain text\n');
        const calls = capturePreview(muya);

        doubleClick(muya.domNode.querySelector('.mu-paragraph-content')!);

        expect(calls).toEqual([]);
    });

    it('ignores double-clicks on the empty-image placeholder', () => {
        // `foo` has no recognised image extension, so the engine renders the
        // empty placeholder (no <img> to preview).
        const muya = boot('![](foo)\n');
        const wrapper = muya.domNode.querySelector<HTMLElement>(
            `span.${CLASS_NAMES.MU_EMPTY_IMAGE}`,
        )!;
        expect(wrapper).not.toBeNull();

        const calls = capturePreview(muya);
        doubleClick(wrapper);

        expect(calls).toEqual([]);
    });
});
