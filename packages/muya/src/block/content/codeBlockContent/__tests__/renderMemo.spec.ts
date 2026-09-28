// @vitest-environment happy-dom

import type CodeBlockContent from '../index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLASS_NAMES } from '../../../../config';
import { Muya } from '../../../../muya';

// P2「引擎热点」: every `update()` re-escapes the block's text, re-tokenizes it
// with Prism and replaces the block's innerHTML — plus it built the four marker
// RegExps on every call. `update()` is reached far more often than the payload
// actually changes (create pass, gutter-seeding rAF, language-load callback,
// search / annotation repaints, `updateRefLinkAndImage` re-renders), so the
// render is now memoised on text + resolved language + highlight set.
//
// Evidence: an unchanged payload leaves the DOM object identity intact (no
// innerHTML swap), while a changed text or a new highlight set still repaints.

const hosts: HTMLElement[] = [];

beforeEach(() => {
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (hosts.length)
        hosts.pop()!.remove();
    document.getSelection()?.removeAllRanges();
});

function boot(markdown: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    hosts.push(muya.domNode);

    return muya;
}

// A fence with no info string takes the non-Prism branch (no async language
// load), so the render is fully synchronous under happy-dom. The code content is
// the LAST content in the block's descendant order — the language input comes
// first.
function bootCodeBlock(): CodeBlockContent {
    const muya = boot('```\nconst a = 1\n```\n');

    return muya.editor.scrollPage!.lastContentInDescendant() as unknown as CodeBlockContent;
}

describe('code block highlight render memo', () => {
    it('leaves the DOM untouched when text, language and highlights are unchanged', () => {
        const content = bootCodeBlock();
        const domNode = content.domNode!;
        const rendered = domNode.firstChild;
        expect(rendered).not.toBeNull();

        content.update();
        content.update();

        // Same child node object ⇒ no innerHTML swap happened.
        expect(domNode.firstChild).toBe(rendered);
    });

    it('repaints when the text changed', () => {
        const content = bootCodeBlock();
        const domNode = content.domNode!;
        const rendered = domNode.firstChild;

        content.text = 'const b = 2';
        content.update();

        expect(domNode.firstChild).not.toBe(rendered);
        expect(domNode.textContent).toContain('const b = 2');
        expect(domNode.textContent).not.toContain('const a = 1');
    });

    it('repaints when only the highlight set changed', () => {
        const content = bootCodeBlock();
        const domNode = content.domNode!;
        const rendered = domNode.firstChild;

        content.update(undefined, [{ start: 0, end: 5, active: true }]);

        expect(domNode.firstChild).not.toBe(rendered);
        expect(domNode.innerHTML).toContain(CLASS_NAMES.MU_HIGHLIGHT);

        // …and an unchanged copy of that same highlight set is a cache hit.
        const highlighted = domNode.firstChild;
        content.update(undefined, [{ start: 0, end: 5, active: true }]);
        expect(domNode.firstChild).toBe(highlighted);
    });

    it('escapes the text it renders (the memo must not change what is rendered)', () => {
        const content = bootCodeBlock();
        const domNode = content.domNode!;

        content.text = '<img src=x onerror="alert(1)">';
        content.update();

        expect(domNode.querySelector('img')).toBeNull();
        expect(domNode.textContent).toContain('<img src=x onerror="alert(1)">');
    });

    // Regression the memo itself introduced: language components load
    // ASYNCHRONOUSLY, so the first render has no choice but to emit plain text —
    // while still recording the resolved language name. When the dynamic import
    // lands, `commonMark/codeBlock`'s `setLang` callback calls `update()` again
    // with text + language + highlights all unchanged, so a memo keyed on those
    // three alone hits and the highlight never appears (editing the text is the
    // only way out). Preloaded languages (js/css/html) are unaffected — which is
    // exactly why the cases above, all built on a fence with no info string,
    // never caught it.
    it('async language: the Prism highlight appears once the language component has loaded', async () => {
        const muya = boot('```python\nconst a = 1\n```\n');
        const codeBlock = muya.editor.scrollPage!.queryBlock([0]) as unknown as {
            lang: string;
            lastContentInDescendant: () => { domNode: HTMLElement | null };
        };
        // Same channel `CodeBlock.create` uses (its rAF assigns the info string):
        // it starts the dynamic Prism import and, once it resolves, calls
        // `lastContentInDescendant().update()`.
        codeBlock.lang = 'python';

        const domNode = codeBlock.lastContentInDescendant().domNode!;
        // Deliberately no manual `update()` here — the language-load callback
        // must be enough on its own.
        for (let i = 0; i < 60 && !domNode.innerHTML.includes('class="token'); i++)
            await new Promise(resolve => setTimeout(resolve, 50));

        expect(domNode.innerHTML).toContain('class="token');
        expect(domNode.textContent).toContain('const a = 1');
    });
});
