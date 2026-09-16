// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildFrameSourceMessage, hasInlineScript, scriptFramePageUrl } from '../htmlPreview';

// 块内含脚本 → 整个块进沙箱 iframe：源码投递给随应用打包的 file:// 引导页
// （src/renderer/public/html-frame.html），由它 document.write 解析执行。
// 不能用 srcdoc —— 本地文档会继承渲染层 CSP（script-src 'self'），内联脚本被拦。
describe('hasInlineScript', () => {
    it('detects a script tag next to plain HTML', () => {
        expect(hasInlineScript('<div id="c"></div>\n<script>draw()</script>')).toBe(true);
    });

    it('detects uppercase and attribute-bearing variants', () => {
        expect(hasInlineScript('<SCRIPT>S</SCRIPT>')).toBe(true);
        expect(hasInlineScript('<script type="module" src="a.js"></script>')).toBe(true);
    });

    it('keeps static HTML on the sanitized inline path', () => {
        expect(hasInlineScript('<div style="color:red">x</div>')).toBe(false);
        expect(hasInlineScript('<table><tr><td>1</td></tr></table>')).toBe(false);
    });

    it('does not fire on prose that merely mentions scripts', () => {
        expect(hasInlineScript('<p>script 标签怎么用</p>')).toBe(false);
    });
});

describe('sandbox frame plumbing', () => {
    it('resolves the bootstrap page next to the renderer document', () => {
        expect(scriptFramePageUrl().endsWith('/html-frame.html')).toBe(true);
    });

    it('carries the author source verbatim in the delivery message', () => {
        const source = '<div id="a"></div><script>document.getElementById("a").textContent = "1";</script>';

        expect(buildFrameSourceMessage(source)).toEqual({ type: 'momark-html-frame-source', html: source });
    });
});
