// @vitest-environment happy-dom

import type Format from '../../block/base/format';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Muya } from '../../muya';

// C-4: undo / redo / replaceContent must land the deferred op batch before they
// touch the document.
//
// A keystroke only reaches the json state on the next animation frame, while
// undo inverts an entry against the LIVE state and `replaceContent` diffs the
// replacement against the LIVE state. Without a flush both operate on a
// document that is one keystroke behind, and the queued op is then composed on
// top of the result — undoing one step too far, or re-inserting text that was
// just replaced away.

const bootedHosts: HTMLElement[] = [];

beforeEach(() => {
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedHosts.length)
        bootedHosts.pop()!.remove();
    document.getSelection()?.removeAllRanges();
});

function bootMuya(markdown: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    bootedHosts.push(muya.domNode);

    return muya;
}

function firstContent(muya: Muya): Format {
    return muya.editor.scrollPage!.firstContentInDescendant() as unknown as Format;
}

// Let the animation frame that would have applied a still-queued op run. Each
// test asserts AFTER it, so a missing flush shows up as "the queued edit landed
// anyway" instead of being masked by `getMarkdown()`'s own flush.
function nextFrame(): Promise<void> {
    return new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

describe('history flushes the pending batch first (C-4)', () => {
    it('undo applies and records the queued keystroke, then reverts it', async () => {
        const muya = bootMuya('hello\n');
        const leaf = firstContent(muya);

        leaf.text = 'hello world'; // queued, not applied yet

        muya.undo();
        await nextFrame();

        // The queued edit was applied, recorded as its own boundary and undone:
        // the document is back to 'hello'. Without the flush the undo would have
        // found an empty stack and the frame would have applied 'hello world'.
        expect(muya.getMarkdown().trim()).toBe('hello');

        // …and redo brings it back.
        muya.redo();
        expect(muya.getMarkdown().trim()).toBe('hello world');
    });

    it('a second undo reaches the previous entry', async () => {
        const muya = bootMuya('hello\n');
        const leaf = firstContent(muya);

        leaf.text = 'hello world';
        muya.flush();

        // Two edits inside the grouping delay are ONE undo step by design, so
        // force a boundary to keep the entries separate in this test.
        muya.editor.history.cutoff();

        leaf.text = 'hello world again';
        muya.undo(); // flushes + reverts only the second edit
        await nextFrame();

        expect(muya.getMarkdown().trim()).toBe('hello world');
    });

    it('replaceContent lands the queued keystroke before diffing the replacement', async () => {
        const muya = bootMuya('hello\n');
        const leaf = firstContent(muya);

        leaf.text = 'hello world'; // queued

        expect(muya.replaceContent('BRAND NEW\n')).toBe(true);
        await nextFrame();

        // No stale op was left to be composed on top of the new document (which
        // used to re-insert ' world' into the replacement).
        expect(muya.getMarkdown().trim()).toBe('BRAND NEW');

        // The queued edit was applied BEFORE the replacement was diffed, so the
        // replacement's recorded inverse restores it.
        muya.undo();
        expect(muya.getMarkdown().trim()).toBe('hello world');
    });
});
