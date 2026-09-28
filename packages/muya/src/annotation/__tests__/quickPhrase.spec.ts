import { describe, expect, it } from 'vitest';
import {
    collectablePhrase,
    composeNote,
    normalizePhrase,
    normalizePhraseList,
    QUICK_PHRASE_MAX_COUNT,
    QUICK_PHRASE_MAX_LEN,
} from '../quickPhrase';

// 常用语纯函数（标注卡片 chips 的规则核心）：备注合成「永不丢手写字」、
// 采集判定「列表满 / 空值 / 换行 / 超长 / 重复一律不可采」、
// 规范化「判定与写入同源」（全角空格是中文输入法下的高频漂移源）。

const PHRASES = ['看不懂，优化表达', '删掉', '写详细', '待定'];

describe('normalizePhrase · 规范化', () => {
    it('folds every kind of whitespace into one plain space', () => {
        // 全角空格（U+3000）是中文输入法下最常见的「看起来一样、其实不等」
        expect(normalizePhrase('删掉　重写')).toBe('删掉 重写');
        expect(normalizePhrase('删掉\t\t重写')).toBe('删掉 重写');
        expect(normalizePhrase('  删掉   重写  ')).toBe('删掉 重写');
    });

    it('handles non-string input defensively', () => {
        expect(normalizePhrase(undefined)).toBe('');
        expect(normalizePhrase(null)).toBe('');
    });
});

describe('composeNote · 备注合成', () => {
    it('uses the phrase itself for an empty note', () => {
        expect(composeNote('', '删掉')).toBe('删掉');
        expect(composeNote('   \n  ', '删掉')).toBe('删掉');
    });

    it('keeps the typed note untouched when it already contains the phrase', () => {
        expect(composeNote('删掉', '删掉')).toBe('删掉');
        // 逐行规范化后全等也算已包含（行首行尾的空白、全角空格都不算差异）
        expect(composeNote('先看这里\n  删掉  ', '删掉')).toBe('先看这里\n  删掉  ');
        expect(composeNote('先看这里\n删掉　', '删掉')).toBe('先看这里\n删掉　');
    });

    it('appends with a newline instead of overwriting the typed note', () => {
        expect(composeNote('这段逻辑不通', '删掉')).toBe('这段逻辑不通\n删掉');
    });

    it('does not add an extra blank line when the note already ends with newlines', () => {
        expect(composeNote('这段逻辑不通\n', '删掉')).toBe('这段逻辑不通\n删掉');
        expect(composeNote('这段逻辑不通\n\n\n', '删掉')).toBe('这段逻辑不通\n删掉');
    });

    it('cleans trailing whitespace-only lines too (not just newlines)', () => {
        // 只去 `\n` 的正则会留下 `"这段逻辑不通\n  "` 这一行空白
        expect(composeNote('这段逻辑不通\n  \n', '删掉')).toBe('这段逻辑不通\n删掉');
    });

    it('appends again after the note was edited so it no longer contains the phrase', () => {
        let note = composeNote('', '写详细');
        note = composeNote(note, '删掉');
        expect(note).toBe('写详细\n删掉');

        // 手改过第一行（不再等于常用语）后再点同一枚 chip 也只追加，不覆盖
        note = composeNote(`写详细，补个例子\n删掉`, '写详细');
        expect(note).toBe('写详细，补个例子\n删掉\n写详细');
    });
});

describe('collectablePhrase · 存为常用语的采集判定', () => {
    it('returns the normalized value when collectable', () => {
        expect(collectablePhrase('  补一个字段  ', PHRASES)).toBe('补一个字段');
        // 全角空格被折叠：返回的正是将来会存进偏好、也是下次比对时用的那个值
        expect(collectablePhrase('删掉　重写', PHRASES)).toBe('删掉 重写');
    });

    it('refuses when the list is full', () => {
        const full = Array.from({ length: QUICK_PHRASE_MAX_COUNT }, (_, i) => `语${i + 1}`);
        expect(collectablePhrase('新的一条', full)).toBeNull();
    });

    it('refuses empty values', () => {
        expect(collectablePhrase('', PHRASES)).toBeNull();
        expect(collectablePhrase('   \n ', PHRASES)).toBeNull();
        expect(collectablePhrase('　　', PHRASES)).toBeNull();
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

    it('refuses duplicates of the existing phrases (whitespace-insensitively)', () => {
        expect(collectablePhrase('删掉', PHRASES)).toBeNull();
        expect(collectablePhrase('  删掉  ', PHRASES)).toBeNull();
        expect(collectablePhrase('删掉　', PHRASES)).toBeNull();
    });

    it('honours custom limits', () => {
        expect(collectablePhrase('二字', PHRASES, 2)).toBe('二字');
        expect(collectablePhrase('三个字', PHRASES, 2)).toBeNull();
        expect(collectablePhrase('新的一条', PHRASES, QUICK_PHRASE_MAX_LEN, 4)).toBeNull();
    });
});

describe('normalizePhraseList · 整表规范化', () => {
    it('normalizes, drops blanks, de-duplicates and truncates', () => {
        expect(normalizePhraseList(['  删掉  ', '删掉　', '', '   ', '写详细'])).toEqual(['删掉', '写详细']);
        expect(normalizePhraseList(['a', 'a', 'b'], 1)).toEqual(['a']);
        expect(normalizePhraseList(['字'.repeat(QUICK_PHRASE_MAX_LEN + 1), 'ok'])).toEqual(['ok']);
    });

    it('returns an empty list for non-array input', () => {
        expect(normalizePhraseList(undefined)).toEqual([]);
        expect(normalizePhraseList('删掉')).toEqual([]);
    });
});
