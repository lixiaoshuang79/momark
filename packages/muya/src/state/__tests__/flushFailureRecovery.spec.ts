// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Muya } from '../../muya';

// P0-9: a flush that throws used to leave the batch in the cache (`clear` sat
// after `apply`), so every later flush re-composed and re-threw the same bad
// op. The json state froze on the last good content for the rest of the session
// while the DOM kept accepting edits — and every save kept writing the stale
// text. The fix drops the batch first (a poisoned op can never persist) and
// rebuilds the state from the block tree, which is what the user actually sees.

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

function firstContent(muya: Muya): Content {
    return muya.editor.scrollPage!.firstContentInDescendant() as Content;
}

describe('json state self-heals when a flush throws (P0-9)', () => {
    it('drops the poisoned batch, rebuilds from the block tree and reports', () => {
        const muya = boot('hello\n');
        const leaf = firstContent(muya);

        const reported: unknown[] = [];
        muya.eventCenter.on('json-state-error', ({ error }) => reported.push(error));

        // A visible edit the user already sees in the DOM…
        leaf.text = 'hello world';
        // …plus an op that cannot be applied to it (an out-of-range text retain,
        // the shape a mangled emoji / composition edit leaves behind).
        muya.editor.jsonState.editOperation([0, 'text'], [99, 'x']);

        expect(() => muya.flush()).not.toThrow();

        // The failure was reported and the state now matches what is on screen:
        // the document is not frozen on the last good state.
        expect(reported).toHaveLength(1);
        expect(reported[0]).toBeInstanceOf(Error);
        expect(muya.getMarkdown().trim()).toBe('hello world');
        expect((muya.getState()[0] as { text?: string }).text).toBe('hello world');
    });

    it('keeps the session editable and no longer re-throws', () => {
        const muya = boot('hello\n');
        const leaf = firstContent(muya);

        let reported = 0;
        muya.eventCenter.on('json-state-error', () => {
            reported += 1;
        });

        leaf.text = 'hello world';
        muya.editor.jsonState.editOperation([0, 'text'], [99, 'x']);
        muya.flush();

        // The poisoned batch is gone: flushing again (with nothing queued) must
        // not re-report, and further edits land normally.
        muya.flush();
        expect(reported).toBe(1);

        leaf.text = 'hello again';
        muya.flush();
        expect(muya.getMarkdown().trim()).toBe('hello again');
        expect(reported).toBe(1);
    });

    it('leaves a clean session untouched (no error event on a normal flush)', () => {
        const muya = boot('hello\n');
        const leaf = firstContent(muya);

        let reported = 0;
        muya.eventCenter.on('json-state-error', () => {
            reported += 1;
        });

        leaf.text = 'hello world';
        muya.flush();

        expect(reported).toBe(0);
        expect(muya.getMarkdown().trim()).toBe('hello world');
    });
});
