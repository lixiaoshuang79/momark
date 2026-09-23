import { describe, expect, it } from 'vitest';
import { findHtmlBlockSpans, stripHtmlBlocks } from '../htmlBlock';

// 块级内嵌 HTML 的行范围扫描：导出时要把「带沙箱帧的块」替换成截图，靠它定位
// 该替换 markdown 里的哪几行。判定与 stripHtmlBlocks 共用，所以这里只钉住
// 「范围对不对」与「围栏代码块里不算块」两类事实。
describe('findHtmlBlockSpans', () => {
    it('locates a multi-line block between paragraphs', () => {
        const spans = findHtmlBlockSpans('one\n\n<div>\n  <p>x</p>\n</div>\n\ntwo');

        expect(spans).toHaveLength(1);
        expect(spans[0].start).toBe(2);
        expect(spans[0].end).toBe(5);
        expect(spans[0].blankTerminated).toBe(true);
        expect(spans[0].text).toBe('<div>\n  <p>x</p>\n</div>');
    });

    it('ends a script block at its closing tag, not at a blank line', () => {
        const spans = findHtmlBlockSpans('text\n\n<script>\ndraw()\n\nmore()\n</script>\n\nmore');

        expect(spans).toHaveLength(1);
        expect(spans[0].start).toBe(2);
        expect(spans[0].end).toBe(7);
        expect(spans[0].blankTerminated).toBe(false);
        expect(spans[0].text).toBe('<script>\ndraw()\n\nmore()\n</script>');
    });

    it('keeps html written inside a fenced code block', () => {
        expect(findHtmlBlockSpans('para\n\n```html\n<div>x</div>\n```\n\nafter')).toEqual([]);
    });

    it('does not swallow a fence that follows a block', () => {
        const spans = findHtmlBlockSpans('<div>x</div>\n\n```js\n1\n```');

        expect(spans).toHaveLength(1);
        expect(spans[0].text).toBe('<div>x</div>');
    });

    it('counts an unterminated block up to the end of the document', () => {
        const spans = findHtmlBlockSpans('x\n\n<div>\n<p>a</p>');

        expect(spans).toHaveLength(1);
        expect(spans[0].start).toBe(2);
        expect(spans[0].end).toBe(4);
        expect(spans[0].text).toBe('<div>\n<p>a</p>');
    });

    it('returns every block in document order', () => {
        const spans = findHtmlBlockSpans('<div>a</div>\n\nmid\n\n<script>b()</script>\n\nend');

        expect(spans.map(s => [s.start, s.end])).toEqual([
            [0, 1],
            [4, 5],
        ]);
    });

    it('recognises a block inside a blockquote container', () => {
        const spans = findHtmlBlockSpans('> 引用\n>\n> <div>\n> 中文\n> </div>\n>\n> 结尾');

        expect(spans).toHaveLength(1);
        expect(spans[0].start).toBe(2);
        expect(spans[0].end).toBe(5);
        expect(spans[0].text).toBe('> <div>\n> 中文\n> </div>');
    });

    it('does not treat a lone tag mid-paragraph as a block', () => {
        expect(findHtmlBlockSpans('text\n<br>\nmore')).toEqual([]);
        expect(findHtmlBlockSpans('text\n\n<br>\n\nmore')).toHaveLength(1);
    });

    it('reports nothing for plain prose', () => {
        expect(findHtmlBlockSpans('# 标题\n\n正文一段。\n\n- 列表\n- 项\n')).toEqual([]);
    });
});

// 内嵌 HTML 块的外框尺寸是块前面的一行 `<!--momark-frame …-->` 注释
// （utils/htmlFrameMarker.ts）。它是 CommonMark 的「类型 2」HTML 块（`<!--` 起、
// `-->` 止），因此这一行必须继续被认成 HTML 块的一部分 —— 否则字数统计会把
// 它当成正文，且注释与块会各自被算作两块。
describe('findHtmlBlockSpans — 外框尺寸注释', () => {
    it('把尺寸注释与其后的 HTML 识别成连续的块', () => {
        const spans = findHtmlBlockSpans('<!--momark-frame w=960 h=436 z=1-->\n<div>x</div>\n');

        expect(spans).toHaveLength(2);
        expect(spans[0].text).toBe('<!--momark-frame w=960 h=436 z=1-->');
        expect(spans[1].text).toBe('<div>x</div>');
    });

    it('注释不影响后续正文的识别', () => {
        const spans = findHtmlBlockSpans('<!--momark-frame w=960-->\n<div>x</div>\n\nafter\n');

        expect(spans.map(span => span.text)).toEqual(['<!--momark-frame w=960-->', '<div>x</div>']);
    });

    it('剔除块后正文保留，注释不残留', () => {
        // wordCount 用的正是 stripHtmlBlocks 这条链路：注释与块一起被剔掉
        // （注释本身不进字数），剩下的正文原样保留。
        const kept = stripHtmlBlocks('one\n\n<!--momark-frame w=960-->\n<div>x</div>\n\ntwo');

        expect(kept).toContain('one');
        expect(kept).toContain('two');
        expect(kept).not.toContain('momark-frame');
        expect(kept).not.toContain('<div>');
    });
});
