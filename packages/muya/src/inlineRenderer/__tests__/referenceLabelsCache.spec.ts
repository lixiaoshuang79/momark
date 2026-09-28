// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../muya';

// P2「加载/渲染 O(N²)」clone elimination, part 1
// (`src/inlineRenderer/index.ts`:62-63, 83-104).
//
// `patch()` runs once per inline-rendered block — once per block while a
// document is being opened, once per keystroke afterwards — and every call
// re-collected the reference labels via `jsonState.getState()`, which
// deep-clones the ENTIRE document. Opening an N-block document therefore paid N
// full-document `structuredClone`s plus N whole-tree walks. The collection now
// reads the live state and is keyed on `jsonState.revision`, so it runs once per
// document version instead of once per block.
//
// Evidence: (1) a full re-render pass over every content block performs ZERO
// state clones; (2) the label map is the same object across patches within one
// version; (3) editing a definition still invalidates it, and the referencing
// block renders the new href.

const hosts: HTMLElement[] = [];

beforeEach(() => {
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (hosts.length)
        hosts.pop()!.remove();
    document.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
});

function boot(markdown: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    hosts.push(muya.domNode);

    return muya;
}

function contentBlocks(muya: Muya): Content[] {
    const blocks: Content[] = [];
    muya.editor.scrollPage!.breadthFirstTraverse((node) => {
        if (node.isContent())
            blocks.push(node as Content);
    });

    return blocks;
}

const DOC = 'foo [bar][1]\n\n[1]: https://example.com "title"\n\nlast\n';

describe('reference labels are collected per document version, not per block', () => {
    it('a full re-render pass clones the state zero times', () => {
        const muya = boot(DOC);
        const { jsonState, inlineRenderer } = muya.editor;
        const getState = vi.spyOn(jsonState, 'getState');

        const blocks = contentBlocks(muya);
        expect(blocks.length).toBeGreaterThan(1);

        for (const block of blocks)
            block.update();

        // Every patch went through the label collection, and none of them cloned
        // the document. (Warming the spy with the first patch is unnecessary:
        // the identity-op free path must hold for all of them.)
        expect(getState).not.toHaveBeenCalled();
        // Sanity: the collection did happen and produced the document's labels.
        expect(inlineRenderer.labels.get('1')).toEqual({
            href: 'https://example.com',
            title: 'title',
        });
    });

    it('reuses one label map across patches while the document is unchanged', () => {
        const muya = boot(DOC);
        const { inlineRenderer } = muya.editor;
        const blocks = contentBlocks(muya);

        const first = inlineRenderer.labels;
        for (const block of blocks)
            block.update();

        expect(inlineRenderer.labels).toBe(first);
    });

    it('invalidates on a state change and renders the new href', () => {
        const muya = boot(DOC);
        const { inlineRenderer } = muya.editor;
        const before = inlineRenderer.labels;

        const definition = contentBlocks(muya).find(b => b.text.startsWith('[1]:'))!;
        const referencing = contentBlocks(muya).find(b => b.text.includes('[bar][1]'))!;
        expect(definition).toBeDefined();
        expect(referencing.domNode!.innerHTML).toContain('https://example.com');

        definition.text = '[1]: https://changed.example.com';
        muya.flush(); // lands the queued op, bumping the state revision
        referencing.update();

        expect(inlineRenderer.labels).not.toBe(before);
        expect(inlineRenderer.labels.get('1')).toEqual({
            href: 'https://changed.example.com',
            title: '',
        });
        expect(referencing.domNode!.innerHTML).toContain('https://changed.example.com');
        expect(referencing.domNode!.innerHTML).not.toContain('https://example.com"');
    });
});
