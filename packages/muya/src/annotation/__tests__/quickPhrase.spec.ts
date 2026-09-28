import { describe, expect, it } from 'vitest';
import {
    collectablePhrase,
    composeNote,
    QUICK_PHRASE_MAX_COUNT,
    QUICK_PHRASE_MAX_LEN,
} from '../quickPhrase';

// 常用语纯函数（标注卡片 chips 的规则核心）：备注合成「永不丢手写字」、
// 采集判定「列表满 / 空值 / 换行 / 超长 / 重复一律不可采」。

const PHRASES = ['看不懂，优化表达', '删掉', '写详细', '待定'];

describe('composeNote · 备注合成', () => {
    it('uses the phrase itself for an empty note', () => {
        expect(composeNote('', '删掉', PHRASES)).toBe('删掉');
        expect(composeNote('   \n  ', '删掉', PHRASES)).toBe('删掉');
    });

    it('keeps the typed note untouched when it already contains the phrase', () => {
        expect(composeNote('删掉', '删掉', PHRASES)).toBe('删掉');
        // 逐行 trim 后全等也算已包含（行首行尾的空格不算差异）
        expect(composeNote('先看这里\n  删掉  ', '删掉', PHRASES)).toBe('先看这里\n  删掉  ');
    });

    it('appends with a newline instead of overwriting the typed note', () => {
        expect(composeNote('这段逻辑不通', '删掉', PHRASES)).toBe('这段逻辑不通\n删掉');
    });

    it('does not add an extra blank line when the note already ends with newlines', () => {
        expect(composeNote('这段逻辑不通\n', '删掉', PHRASES)).toBe('这段逻辑不通\n删掉');
        expect(composeNote('这段逻辑不通\n\n\n', '删掉', PHRASES)).toBe('这段逻辑不通\n删掉');
    });

    it('appends again after the note was edited so it no longer contains the phrase', () => {
        let note = composeNote('', '写详细', PHRASES);
        note = composeNote(note, '删掉', PHRASES);
        expect(note).toBe('写详细\n删掉');

        // 手改过第一行（不再等于常用语）后再点同一枚 chip 也只追加，不覆盖
        note = composeNote(`写详细，补个例子\n删掉`, '写详细', PHRASES);
        expect(note).toBe('写详细，补个例子\n删掉\n写详细');
    });
});

describe('collectablePhrase · 存为常用语的采集判定', () => {
    it('returns the trimmed value when collectable', () => {
        expect(collectablePhrase('  补一个字段  ', PHRASES)).toBe('补一个字段');
    });

    it('refuses when the list is full', () => {
        const full = Array.from({ length: QUICK_PHRASE_MAX_COUNT }, (_, i) => `语${i + 1}`);
        expect(collectablePhrase('新的一条', full)).toBeNull();
    });

    it('refuses empty values', () => {
        expect(collectablePhrase('', PHRASES)).toBeNull();
        expect(collectablePhrase('   \n ', PHRASES)).toBeNull();
    });

    it('refuses values longer than the limit (counted by code points)', () => {
        expect(collectablePhrase('字'.repeat(QUICK_PHRASE_MAX_LEN), PHRASES)).toBe('字'.repeat(QUICK_PHRASE_MAX_LEN));
        expect(collectablePhrase('字'.repeat(QUICK_PHRASE_MAX_LEN + 1), PHRASES)).toBeNull();
        // 一个中文字是一个码点，24 个汉字正好在上限内
        expect([...'字'.repeat(QUICK_PHRASE_MAX_LEN)].length).toBe(24);
    });

    it('refuses the values with inner newlines (only single-line notes are collectable)', () => {
        expect(collectablePhrase('第一行\n第二行', PHRASES)).toBeNull();
    });

    it('refuses duplicates of the existing phrases', () => {
        expect(collectablePhrase('删掉', PHRASES)).toBeNull();
        expect(collectablePhrase('  删掉  ', PHRASES)).toBeNull();
    });

    it('honours custom limits', () => {
        expect(collectablePhrase('二字', PHRASES, 2)).toBe('二字');
        expect(collectablePhrase('三个字', PHRASES, 2)).toBeNull();
        expect(collectablePhrase('新的一条', PHRASES, QUICK_PHRASE_MAX_LEN, 4)).toBeNull();
    });
});
