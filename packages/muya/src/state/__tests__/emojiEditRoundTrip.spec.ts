// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Muya } from '../../muya';

// P0-7 property test — "DOM text vs getMarkdown() round-trip".
//
// The typing path reads the DOM back into the block
// (`Format.inputHandler` does `this.text = getTextContent(domNode)`) and the
// `Content.text` setter turns the change into a `text-unicode` op via
// `diffToTextOp`. `ot-text-unicode` positions by CODE POINT while the old
// retain value came from `Intl.Segmenter` (GRAPHEME clusters), so every
// multi-code-point glyph moved the edit: the DOM (assigned directly) kept
// showing what the user typed while the json state — and therefore the saved
// markdown — drifted. This spec replays real edits against a live engine and
// asserts the serialized document still equals the DOM text.

// Every non-BMP / multi-codepoint literal is spelled with escapes so an editor
// normalizing the file cannot silently change the case under test.
const ZWJ_FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 👨‍👩‍👧 — 5 code points
const ZWJ_TECH = '\u{1F469}‍\u{1F4BB}'; // 👩‍💻 — ZWJ profession
const FLAG_CN = '\u{1F1E8}\u{1F1F3}';
const FLAG_JP = '\u{1F1EF}\u{1F1F5}';
const COMBINING_ACUTE = 'é'; // e + U+0301
const HEART_VS = '❤️'; // ❤️ — heart + variation selector
const THUMB_TONE = '\u{1F44D}\u{1F3FD}'; // 👍🏽 — thumbs up + skin tone

// Deliberately free of markdown syntax characters, so `getMarkdown()` is a
// faithful echo of the paragraph text (`1.` / `*` / `#` would re-serialize as
// block syntax and make the comparison meaningless).
const ATOMS = [
    ZWJ_FAMILY,
    ZWJ_TECH,
    FLAG_CN,
    FLAG_JP,
    COMBINING_ACUTE,
    HEART_VS,
    THUMB_TONE,
    'a',
    'B',
    '7',
    '中',
];

// Deterministic PRNG (mulberry32): a failing case is reproducible from the seed.
function makeRandom(seed: number) {
    let a = seed;

    return (n: number) => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) % n;
    };
}

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

// Replay a native contenteditable edit: the browser rewrites the deepest
// rendered node (the paragraph renders as
// `span.mu-content > span.mu-plain-text`), then the engine's input handler reads
// the DOM back into the block (`this.text = getTextContent(domNode)`, which for
// unstyled text is just the subtree's textContent).
function typeInDom(content: Content, text: string) {
    const root = content.domNode!;
    let target: Node = root;

    while (target.firstChild && target.firstChild.nodeType === Node.ELEMENT_NODE)
        target = target.firstChild;

    target.textContent = text;
    content.text = root.textContent ?? '';
}

// What the user sees (the DOM) vs. what a save would write (the json state).
function expectStateMatchesDom(muya: Muya, content: Content, step: string) {
    const domText = content.domNode!.textContent ?? '';
    muya.flush();

    expect(muya.getMarkdown().trim(), `markdown != DOM text ${step}`).toBe(domText);
    expect(
        (muya.getState()[0] as { text?: string }).text,
        `json state != DOM text ${step}`,
    ).toBe(domText);
}

function insertAt(text: string, insert: string, at: number): string {
    const points = [...text];

    return points.slice(0, at).join('') + insert + points.slice(at).join('');
}

describe('emoji edits — the DOM text and getMarkdown() stay in sync (P0-7)', () => {
    it('keeps the audit repro in step (👨‍👩‍👧a + b)', () => {
        const muya = boot(`${ZWJ_FAMILY}a\n`);
        const content = firstContent(muya);

        typeInDom(content, `${ZWJ_FAMILY}ab`);
        expectStateMatchesDom(muya, content, 'after appending b');
        expect(muya.getMarkdown().trim()).toBe(`${ZWJ_FAMILY}ab`);
    });

    it('keeps every intermediate step of a run in step', () => {
        const muya = boot('\n');
        const content = firstContent(muya);
        const random = makeRandom(0x5EED);
        let text = '';

        for (let step = 0; step < 40; step++) {
            const atom = ATOMS[random(ATOMS.length)];
            const at = random([...text].length + 1);
            text = insertAt(text, atom, at);

            typeInDom(content, text);
            expectStateMatchesDom(muya, content, `at step ${step} (${JSON.stringify(text)})`);
        }

        expect(muya.getMarkdown().trim()).toBe(text);
    });

    it('indexes randomly generated emoji documents end to end', () => {
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const random = makeRandom(seed);
            const muya = boot('\n');
            const content = firstContent(muya);
            let text = '';

            for (let step = 0; step < 12; step++) {
                const atom = ATOMS[random(ATOMS.length)];
                const at = random([...text].length + 1);
                text = insertAt(text, atom, at);

                typeInDom(content, text);
                expectStateMatchesDom(muya, content, `seed ${seed}, step ${step}`);
            }

            muya.destroy();
        }
    });
});
