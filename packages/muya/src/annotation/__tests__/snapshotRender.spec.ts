// @vitest-environment jsdom
// jsdom 而不是 happy-dom：happy-dom 下 DOMPurify 会吃掉开头元素的标签（`<h2>` 变裸文本），
// 与 Chromium 行为不符；jsdom 与真实渲染一致。

import { describe, expect, it } from 'vitest';
import { renderSnapshotHtml, SNAPSHOT_MARK_CLASS } from '../snapshotRender';

function render(markdown: string, quote: string | null, kind: Parameters<typeof renderSnapshotHtml>[0]['kind'] = 'paragraph') {
    const markStart = quote == null ? -1 : markdown.indexOf(quote);
    const markEnd = quote == null ? -1 : markStart + quote.length;
    const html = renderSnapshotHtml({ markdown, markStart, markEnd, kind });
    const host = document.createElement('div');
    host.innerHTML = html;
    return { html, host, marks: [...host.querySelectorAll(`mark.${SNAPSHOT_MARK_CLASS}`)].map(node => node.textContent) };
}

describe('renderSnapshotHtml', () => {
    it('标题：渲染出真实级别，区间包进 mark，不残留哨兵', () => {
        const { host, marks, html } = render('## 1. 登录与引导', '登录');
        expect(host.querySelector('h2')).not.toBeNull();
        expect(marks).toEqual(['登录']);
        expect(html).not.toMatch(/[\u3400-\u3405]/);
    });

    it('区间跨越加粗：加粗仍然成立，mark 按文本节点分段', () => {
        const { host, marks } = render('三步，**不再强制登录**，用户可以', '**不再强制登录**，用户');
        expect(host.querySelector('strong')?.textContent).toBe('不再强制登录');
        expect(marks.join('')).toBe('不再强制登录，用户');
    });

    it('表格单元格：表格结构完整，只有单元格文字被 mark', () => {
        const markdown = '| 状态 | 期望表现 |\n| --- | --- |\n| 已登录 | 同步书架与阅读进度 |';
        const { host, marks } = render(markdown, '同步书架与阅读进度');
        expect(host.querySelectorAll('tr')).toHaveLength(2);
        expect(marks).toEqual(['同步书架与阅读进度']);
        expect(host.querySelector('td mark')).not.toBeNull();
    });

    it('代码块：语法高亮切成多个 token 时也能找到哨兵', () => {
        const markdown = '```ts\ntype ReaderMode = \'scroll\' | \'page\'\n```';
        const { host, marks, html } = render(markdown, 'ReaderMode = \'scroll\'', 'code');
        expect(host.querySelector('pre')).not.toBeNull();
        expect(marks.join('')).toBe('ReaderMode = \'scroll\'');
        expect(html).not.toMatch(/[\u3400-\u3405]/);
    });

    it('无区间（段落级对应 / 公式）只渲染不画 mark', () => {
        expect(render('普通段落', null).marks).toEqual([]);
        expect(render('$$\nx^2\n$$', '$$\nx^2\n$$', 'math').marks).toEqual([]);
    });

    it('清洗仍然生效：脚本与事件属性被剥掉', () => {
        const { html } = render('<img src=x onerror="alert(1)"> 文本 <script>alert(1)</script>', '文本');
        expect(html).not.toMatch(/onerror|<script/i);
    });
});
