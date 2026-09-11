// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { extractIframeSlots } from '../htmlPreview';

// Interactive HTML embeds: iframes are swapped for inert text slots before
// DOMPurify sanitization (its html profile strips the tag entirely) and
// restored as sandboxed iframes afterwards.
describe('extractIframeSlots', () => {
    it('swaps an iframe for a text slot and keeps whitelisted attrs', () => {
        const frames = new Map<string, {
            src: string;
            style: string;
            width: string;
            height: string;
            title: string;
        }>();
        const out = extractIframeSlots(
            '<iframe src="chart.html" style="width:100%;height:264px" width="500" height="300" title="图表"></iframe>',
            frames,
        );
        expect(out).toBe('<span>@@MU_FRAME_0@@</span>');
        expect(frames.size).toBe(1);
        expect([...frames.values()][0]).toEqual({
            src: 'chart.html',
            style: 'width:100%;height:264px',
            width: '500',
            height: '300',
            title: '图表',
        });
    });

    it('drops iframes without src', () => {
        const frames = new Map<string, {
            src: string;
            style: string;
            width: string;
            height: string;
            title: string;
        }>();
        const out = extractIframeSlots('<iframe></iframe>', frames);
        expect(out).toBe('');
        expect(frames.size).toBe(0);
    });

    it('drops fallback content and ignores non-whitelisted attributes', () => {
        const frames = new Map<string, {
            src: string;
            style: string;
            width: string;
            height: string;
            title: string;
        }>();
        const out = extractIframeSlots(
            '<iframe src="a.html" onload="x()" srcdoc="<b>bad</b>" sandbox="allow-same-origin">fallback text</iframe>',
            frames,
        );
        expect(out).toBe('<span>@@MU_FRAME_0@@</span>');
        expect([...frames.values()][0].src).toBe('a.html');
    });

    it('leaves surrounding html intact and numbers slots', () => {
        const frames = new Map<string, {
            src: string;
            style: string;
            width: string;
            height: string;
            title: string;
        }>();
        const out = extractIframeSlots(
            '<div>前置</div>\n<iframe src="a.html"></iframe>\n<iframe src="b.html"></iframe>\n<div>后置</div>',
            frames,
        );
        expect(out).toBe('<div>前置</div>\n<span>@@MU_FRAME_0@@</span>\n<span>@@MU_FRAME_1@@</span>\n<div>后置</div>');
        expect(frames.size).toBe(2);
    });
});
