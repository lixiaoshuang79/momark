// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildSandboxDocument, hasInlineScript } from '../htmlPreview';

// 块内含脚本 → 整个块进沙箱 iframe（srcdoc = 作者原始源码），这样「单个 .md
// 自带可交互原型/脚本图表」才成立：不依赖同目录的 html 文件，也不依赖联网。
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

describe('buildSandboxDocument', () => {
    const source = '<div id="a"></div><script>document.getElementById("a").textContent = "1";</script>';

    it('keeps the author source verbatim (the script is the point)', () => {
        expect(buildSandboxDocument(source).startsWith(source)).toBe(true);
    });

    it('appends the height reporter after the author content', () => {
        const doc = buildSandboxDocument('<p>x</p>');

        expect(doc).toContain('momark-html-frame-height');
        expect(doc.indexOf('<p>x</p>')).toBeLessThan(doc.indexOf('momark-html-frame-height'));
    });
});
