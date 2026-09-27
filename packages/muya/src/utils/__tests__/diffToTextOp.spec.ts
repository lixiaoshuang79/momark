import type { Diff } from 'fast-diff';
import diff from 'fast-diff';
// `ot-text-unicode` is the position model the op is written against: its
// `apply` is the ground truth for what a retain count means (P0-7).
import { type as textType } from 'ot-text-unicode';
import { describe, expect, it } from 'vitest';
import { diffToTextOp } from '../index';

// `diffToTextOp` converts a fast-diff (UTF-16 code-unit) edit script into the
// component list `ot-json1`'s embedded `text-unicode` subtype understands. The
// only subtle part is the retain value for an unchanged run: text-unicode counts
// UNICODE CODE POINTS, while `Intl.Segmenter` counts GRAPHEME CLUSTERS. For any
// glyph built from several code points (ZWJ emoji families, flags, skin-tone
// modifiers, letter + combining mark, `❤️`) the two disagree, and a grapheme
// count lands the next edit in the middle of the glyph — the DOM keeps looking
// right (its text is assigned directly) while the json state, and therefore
// every subsequent save, is corrupted.
//
// These cases pin the contract: applying the produced op to the original text
// with `ot-text-unicode` must reproduce the edited text exactly. Non-ASCII
// literals are spelled as escapes where a base character and its modifier could
// be normalized together.

// 👨‍👩‍👧 = U+1F468 ZWJ U+1F469 ZWJ U+1F467 — 5 code points, 1 grapheme.
const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
// ❤️ = U+2764 + U+FE0F (variation selector).
const heart = '❤️';
// e + U+0301 COMBINING ACUTE ACCENT.
const accented = 'é';
// 🇨🇳 = two regional indicators, U+1F1E8 + U+1F1F3.
const flag = '\u{1F1E8}\u{1F1F3}';

function apply(source: string, target: string): string {
    return textType.apply(source, diffToTextOp(diff(source, target))) as string;
}

describe('diffToTextOp — retains count code points, not grapheme clusters', () => {
    it('round-trips a ZWJ emoji family (5 code points, 1 grapheme)', () => {
        // The audit repro: a grapheme-based retain of 1 put `b` after the first
        // 👨, i.e. inside the family: '👨b👩‍👧a'.
        expect(apply(`${family}a`, `${family}ab`)).toBe(`${family}ab`);
        expect(diffToTextOp([[0, `${family}a`], [1, 'b']])).toEqual([6, 'b']);
    });

    it('counts an astral character as one code point', () => {
        expect(diffToTextOp([[0, '😀'], [1, '!']])).toEqual([1, '!']);
        expect(apply('😀', '😀!')).toBe('😀!');
    });

    it('counts a variation selector / skin tone modifier as its own code point', () => {
        expect(diffToTextOp([[0, heart], [1, '!']])).toEqual([2, '!']);
        expect(apply(`a${heart}`, `a${heart}!`)).toBe(`a${heart}!`);
        // 👍🏽 = U+1F44D + U+1F3FD.
        expect(diffToTextOp([[0, '👍🏽'], [1, '!']])).toEqual([2, '!']);
        expect(apply('👍🏽', '👍🏽!')).toBe('👍🏽!');
    });

    it('counts the code points of a regional-indicator flag', () => {
        expect(diffToTextOp([[0, `${flag}x`], [1, 'y']])).toEqual([3, 'y']);
        expect(apply(`${flag}x`, `${flag}xy`)).toBe(`${flag}xy`);
    });

    it('counts a base letter plus combining mark as two code points', () => {
        expect(diffToTextOp([[0, accented], [1, '!']])).toEqual([2, '!']);
        expect(apply(accented, `${accented}!`)).toBe(`${accented}!`);
    });

    it('counts a surrogate pair once, not twice', () => {
        expect(diffToTextOp([[0, 'a😀b'], [1, '!']])).toEqual([3, '!']);
    });

    it('keeps deletes and inserts verbatim', () => {
        const op = diffToTextOp([[-1, '😀'], [1, 'x']] as Diff[]);
        expect(op).toEqual([{ d: '😀' }, 'x']);
    });

    it('drops trailing retains — an op may not end with a skip', () => {
        expect(diffToTextOp([[1, 'a'], [0, 'bcd']])).toEqual(['a']);
    });
});
