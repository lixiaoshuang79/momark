import { describe, expect, it } from 'vitest';
import {
    canHighlightCode,
    CODE_HIGHLIGHT_MAX_CHARS,
    CODE_HIGHLIGHT_MAX_TOKEN_RUN,
    longestIdentifierRun,
} from '../codeHighlightBudget';

describe('longestIdentifierRun', () => {
    it('counts Prism identifier characters ([$\\w\\xA0-\\uFFFF])', () => {
        expect(longestIdentifierRun('foo(bar_baz$1)')).toBe(9);
        expect(longestIdentifierRun('a+b/c')).toBe(1);
        expect(longestIdentifierRun('中文没有空格也算一段')).toBe(10);
        expect(longestIdentifierRun('')).toBe(0);
    });

    it('stops scanning once the limit is reached', () => {
        expect(longestIdentifierRun('x'.repeat(5000), 10)).toBe(10);
    });
});

describe('canHighlightCode', () => {
    it('allows ordinary code', () => {
        expect(canHighlightCode('function draw() {\n  chart.setOption({ a: 1 });\n}')).toBe(true);
    });

    it('rejects base64-like payloads with a long identifier run', () => {
        // 真实事故载荷：HTML 的 base64 几乎没有 + / 分隔，整段都是标识符字符。
        const payload = 'PCFET0NUWVBFIGh0bWw'.repeat(Math.ceil(CODE_HIGHLIGHT_MAX_TOKEN_RUN / 19) + 1);

        expect(canHighlightCode(`<script type="text/plain">${payload}</script>`)).toBe(false);
        expect(canHighlightCode('y'.repeat(CODE_HIGHLIGHT_MAX_TOKEN_RUN - 1))).toBe(true);
    });

    it('rejects code beyond the total size budget', () => {
        const line = 'const a = b + c;\n';

        expect(canHighlightCode(line.repeat(Math.ceil((CODE_HIGHLIGHT_MAX_CHARS + 1) / line.length)))).toBe(false);
    });
});
