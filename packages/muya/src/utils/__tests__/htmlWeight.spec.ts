import { describe, expect, it } from 'vitest';
import {
    classifyHtmlWeight,
    extractHtmlTitle,
    formatHtmlSize,
    HTML_LITE_MAX_CHARS,
    HTML_LITE_MAX_LINE,
    isHeavyHtml,
    longestLineLength,
} from '../htmlWeight';

// 轻 / 重判定：源码 > 256K 字符，或单行 > 64K 字符，任一命中即重量。
// 是否含 <script> 不参与判定（只作为卡片上的提示）。
const CHART = [
    '<div id="chart" style="width:100%;height:320px"></div>',
    '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>',
    '<script>',
    '  echarts.init(document.getElementById("chart")).setOption({ xAxis: {}, yAxis: {}, series: [{ type: "bar", data: [1, 2, 3] }] });',
    '</script>',
].join('\n');

describe('classifyHtmlWeight', () => {
    it('keeps a typical chart block lightweight', () => {
        const weight = classifyHtmlWeight(CHART);

        expect(weight.heavy).toBe(false);
        expect(weight.reasons).toEqual([]);
        expect(weight.hasScript).toBe(true);
    });

    it('flags a block whose source exceeds the size limit', () => {
        const line = `<p>${'x'.repeat(1000)}</p>\n`;
        const html = line.repeat(Math.ceil((HTML_LITE_MAX_CHARS + 1) / line.length));
        const weight = classifyHtmlWeight(html);

        expect(weight.heavy).toBe(true);
        expect(weight.reasons).toEqual(['size']);
        expect(weight.hasScript).toBe(false);
    });

    it('flags a single over-long line (inline base64 payload) even when the block is small', () => {
        const html = `<div class="x"><script id="d" type="text/plain">${'A'.repeat(HTML_LITE_MAX_LINE + 1)}</script></div>`;
        const weight = classifyHtmlWeight(html);

        expect(weight.heavy).toBe(true);
        expect(weight.reasons).toEqual(['line']);
        expect(weight.longestLine).toBe(html.length);
    });

    it('treats the exact limits as lightweight (strictly greater is heavy)', () => {
        expect(isHeavyHtml('a'.repeat(HTML_LITE_MAX_LINE))).toBe(false);
        expect(isHeavyHtml('a'.repeat(HTML_LITE_MAX_LINE + 1))).toBe(true);

        const lines = `${'b'.repeat(1023)}\n`.repeat(HTML_LITE_MAX_CHARS / 1024);
        expect(lines.length).toBe(HTML_LITE_MAX_CHARS);
        expect(isHeavyHtml(lines)).toBe(false);
        expect(isHeavyHtml(`${lines}c`)).toBe(true);
    });

    it('agrees with isHeavyHtml', () => {
        for (const html of [CHART, 'x'.repeat(HTML_LITE_MAX_LINE + 5), '']) {
            expect(isHeavyHtml(html)).toBe(classifyHtmlWeight(html).heavy);
        }
    });
});

describe('helpers', () => {
    it('measures the longest line', () => {
        expect(longestLineLength('')).toBe(0);
        expect(longestLineLength('ab\nabcd\nabc')).toBe(4);
        expect(longestLineLength('abc\n')).toBe(3);
    });

    it('formats the UTF-8 size', () => {
        expect(formatHtmlSize('a'.repeat(2048))).toBe('2 KB');
        expect(formatHtmlSize('a'.repeat(4.5 * 1024 * 1024))).toBe('4.5 MB');
        // 中文按 UTF-8 3 字节计
        expect(formatHtmlSize('中'.repeat(1024))).toBe('3 KB');
    });

    it('extracts the page title from the head', () => {
        expect(extractHtmlTitle('<html><head><title> 错题本 </title></head></html>')).toBe('错题本');
        expect(extractHtmlTitle('<div>no title</div>')).toBe('');
    });
});
