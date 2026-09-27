// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Muya } from '../../muya';

// #2938 part 2: `muya.flush()` makes a same-frame edit durable before the
// document is swapped out (a tab switch calls setContent within the same frame
// as the last keystroke). Drives the real typing path: `content.text = ...`
// queues an op + schedules a requestAnimationFrame; the op lands only when that
// frame fires — unless flushed first.

const hosts: HTMLElement[] = [];
beforeEach(() => {
    window.MUYA_VERSION = 'test';
});
afterEach(() => {
    while (hosts.length)
        hosts.pop()!.remove();
    document.getSelection()?.removeAllRanges();
});

function boot(md: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown: md } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    hosts.push(muya.domNode);
    return muya;
}

function nextFrame(): Promise<void> {
    return new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

// Read the first block's text straight out of the json state, WITHOUT draining
// the deferred op batch. `getMarkdown()` drains it nowadays (C-4), so it can no
// longer be used to observe the queued state.
function pendingText(muya: Muya): string {
    return (muya.getState()[0] as { text?: string }).text ?? '';
}

describe('muya.flush() — make pending edits durable synchronously (#2938)', () => {
    it('applies a queued edit and emits json-change synchronously', () => {
        const muya = boot('hello\n');
        const leaf = muya.editor.scrollPage!.firstContentInDescendant() as Content;

        let changes = 0;
        muya.eventCenter.on('json-change', () => {
            changes += 1;
        });

        leaf.text = 'hello world'; // queued, not yet applied
        expect(pendingText(muya)).toBe('hello');
        expect(changes).toBe(0);

        muya.flush();

        // The edit is now in the document, and a json-change fired — all without
        // waiting for the animation frame.
        expect(muya.getMarkdown().trim()).toBe('hello world');
        expect(changes).toBe(1);
    });

    it('getMarkdown() lands the queued batch itself — a save never lags a keystroke (C-4)', () => {
        const muya = boot('hello\n');
        const leaf = muya.editor.scrollPage!.firstContentInDescendant() as Content;

        let changes = 0;
        muya.eventCenter.on('json-change', () => {
            changes += 1;
        });

        leaf.text = 'hello world'; // queued

        // No explicit flush: serializing the document is a read of the document,
        // and the shell writes this straight to disk.
        expect(muya.getMarkdown().trim()).toBe('hello world');
        expect(changes).toBe(1);

        // A second read is a no-op (the batch is gone, nothing re-fires).
        expect(muya.getMarkdown().trim()).toBe('hello world');
        expect(changes).toBe(1);
    });

    it('flushing before setContent persists the outgoing edit (no loss, no double-flush)', async () => {
        const muya = boot('hello\n');
        const leaf = muya.editor.scrollPage!.firstContentInDescendant() as Content;

        const captured: string[] = [];
        muya.eventCenter.on('json-change', () => {
            captured.push(muya.getMarkdown().trim());
        });

        leaf.text = 'hello world'; // pending

        // Tab-switch sequence: flush the outgoing doc FIRST, then swap.
        muya.flush();
        expect(captured).toEqual(['hello world']); // outgoing edit captured

        muya.setContent('B\n');
        await nextFrame();
        await nextFrame();

        // No leftover op fired against B, and B is intact.
        expect(captured).toEqual(['hello world']);
        expect(muya.getMarkdown().trim()).toBe('B');
    });

    it('is a no-op when nothing is pending', () => {
        const muya = boot('hello\n');
        let changes = 0;
        muya.eventCenter.on('json-change', () => {
            changes += 1;
        });

        muya.flush();
        muya.flush();

        expect(changes).toBe(0);
        expect(muya.getMarkdown().trim()).toBe('hello');
    });

    it('edits keep flushing normally after a flush', async () => {
        const muya = boot('hello\n');
        const leaf = muya.editor.scrollPage!.firstContentInDescendant() as Content;

        leaf.text = 'one';
        muya.flush();
        expect(muya.getMarkdown().trim()).toBe('one');

        // A subsequent edit still batches + flushes on its own frame.
        const leaf2 = muya.editor.scrollPage!.firstContentInDescendant() as Content;
        leaf2.text = 'two';
        expect(pendingText(muya)).toBe('one'); // still deferred
        await nextFrame();
        expect(muya.getMarkdown().trim()).toBe('two');
    });

    it('flushes when the window is hidden — rAF stops, the batch must not (C-4)', async () => {
        const muya = boot('hello\n');
        const leaf = muya.editor.scrollPage!.firstContentInDescendant() as Content;

        let changes = 0;
        muya.eventCenter.on('json-change', () => {
            changes += 1;
        });

        leaf.text = 'hello world'; // queued behind the animation frame
        expect(changes).toBe(0);

        // A hidden window (occluded / minimised / background tab) never gets the
        // frame the batch is waiting for.
        Object.defineProperty(document, 'visibilityState', {
            value: 'hidden',
            configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));

        expect(changes).toBe(1);
        expect(muya.getMarkdown().trim()).toBe('hello world');

        // Still a fresh batch after the flush: typing goes on as usual.
        const leaf2 = muya.editor.scrollPage!.firstContentInDescendant() as Content;
        leaf2.text = 'hello again';
        await nextFrame();
        expect(muya.getMarkdown().trim()).toBe('hello again');

        // Leave the emulated document state as it was found.
        Object.defineProperty(document, 'visibilityState', {
            value: 'visible',
            configurable: true,
        });
    });
});
