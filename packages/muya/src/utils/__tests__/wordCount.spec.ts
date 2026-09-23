import { describe, expect, it } from 'vitest';
import { wordCount } from '../index';

// Characterization of the current wordCount algorithm in src/utils/index.ts.
// It returns { word, paragraph, character, all }:
//  - paragraph: count of non-empty chunks split on two-or-more newlines.
//  - word: number of CJK chars (一-龥) + number of whitespace tokens
//    in the CJK-stripped string.
//  - character: total length of those non-CJK tokens + number of CJK chars
//    (i.e. excludes whitespace between tokens).
//  - all: the raw markdown string length.
describe('wordCount', () => {
    it('counts plain ASCII words', () => {
        expect(wordCount('hello world')).toEqual({
            word: 2,
            character: 10,
            paragraph: 1,
            all: 11,
        });
    });

    it('counts each CJK character as its own word', () => {
        const result = wordCount('你好 world');
        expect(result.word).toBe(3);
        expect(result.character).toBe(7);
        expect(result.paragraph).toBe(1);
        expect(result.all).toBe(8);
    });

    it('splits paragraphs on blank lines', () => {
        const result = wordCount('a\n\nb\n\nc');
        expect(result.paragraph).toBe(3);
        expect(result.word).toBe(3);
        expect(result.character).toBe(3);
        expect(result.all).toBe(7);
    });

    it('returns all zeros for the empty string', () => {
        expect(wordCount('')).toEqual({
            word: 0,
            character: 0,
            paragraph: 0,
            all: 0,
        });
    });
});

// 内嵌 HTML 块（html-block 的源码）不计入统计：它按 CommonMark 的 HTML 块规则整段剔除，
// 段落边界保留；围栏代码块里写的 HTML 属于代码块内容，照旧计入。
describe('wordCount with embedded HTML blocks', () => {
    it('ignores a multi-line block-level HTML chunk', () => {
        const result = wordCount('before\n\n<div class="a">\n  <span>hi</span>\n</div>\n\nafter');
        expect(result).toEqual({ word: 2, character: 11, paragraph: 2, all: 14 });
    });

    it('ignores a script block closed on its own line', () => {
        const result = wordCount('A\n\n<script>var x = 1;</script>\n\nB');
        expect(result).toEqual({ word: 2, character: 2, paragraph: 2, all: 6 });
    });

    it('ignores CJK text inside an HTML block', () => {
        const result = wordCount('正文\n\n<div>\n中文\n</div>\n\n结尾');
        expect(result).toEqual({ word: 4, character: 4, paragraph: 2, all: 7 });
    });

    it('keeps the paragraph boundary an HTML block created', () => {
        const result = wordCount('one\n\n<div>x</div>\n\ntwo');
        expect(result).toEqual({ word: 2, character: 6, paragraph: 2, all: 9 });
    });

    it('ignores an HTML block inside a block quote', () => {
        const result = wordCount('> 引用\n>\n> <div>\n> 中文\n> </div>\n>\n> 结尾');
        expect(result).toEqual({ word: 7, character: 7, paragraph: 2, all: 12 });
    });

    it('keeps HTML that lives inside a fenced code block', () => {
        const result = wordCount('```html\n<div>x</div>\n```');
        expect(result).toEqual({ word: 3, character: 22, paragraph: 1, all: 24 });
    });

    it('keeps a lone tag that only continues a paragraph', () => {
        const result = wordCount('text\n<br>\nmore');
        expect(result).toEqual({ word: 3, character: 12, paragraph: 1, all: 14 });
    });
});
