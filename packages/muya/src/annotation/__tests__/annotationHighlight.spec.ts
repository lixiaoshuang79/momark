// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type TreeNode from '../../block/base/treeNode';
import type { Muya } from '../../muya';
import type { IAnnotation, TSelectionSnapshot } from '../types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import indexCss from '../../assets/styles/index.css?inline';
import { Muya as MuyaEditor } from '../../muya';

// 标注高亮接入（方案 §5.3）：高亮由 `InlineRenderer.patch` 合并产出，
// class 由 `getHighlightClassName` 按 type 映射，序号角标走 CSS `::after`。
//
// 两条硬约束在这里钉死：
//   ① 角标**绝不能用文本节点**——真实文本会被 selection/dom.ts 的 DOM↔偏移映射
//      算进正文长度，破坏选区与光标。断言口径：span 的 textContent 只有引文本身、
//      整块 DOM 的 textContent 与块源码逐字相同、span 内没有子元素，序号只由
//      样式表里的 `::after { content: attr(data-index) }` 提供。
//   ② 打字后高亮必须常驻——每次 `block.update()`（含每次按键）都重新合并。

const DOC = [
    '# 第一章 概述',
    '',
    '用户可以在任意页面切换角色，系统根据当前角色实时刷新权限。',
    '',
    '第二段内容。',
    '',
].join('\n');

const QUOTE = '用户可以在任意页面切换角色';

const booted: Muya[] = [];

beforeEach(() => {
    booted.length = 0;
});

afterEach(() => {
    while (booted.length) {
        const muya = booted.pop()!;
        muya.destroy();
        muya.domNode.remove();
    }
});

function bootMuya(markdown: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new MuyaEditor(host, { markdown } as ConstructorParameters<typeof MuyaEditor>[1]);
    muya.init();
    booted.push(muya);
    return muya;
}

function contentBlocks(muya: Muya): Content[] {
    const blocks: Content[] = [];
    muya.editor.scrollPage!.depthFirstTraverse((node: TreeNode) => {
        if (node.isContent())
            blocks.push(node);
    });
    return blocks;
}

function snapshotOf(
    anchorBlock: Content,
    anchorOffset: number,
    focusBlock: Content,
    focusOffset: number,
): TSelectionSnapshot {
    return {
        anchor: { offset: anchorOffset, block: anchorBlock, path: anchorBlock.path },
        focus: { offset: focusOffset, block: focusBlock, path: focusBlock.path },
        anchorBlock,
        focusBlock,
        anchorPath: anchorBlock.path,
        focusPath: focusBlock.path,
    };
}

function addAnnotation(
    muya: Muya,
    from: Content,
    fromOffset: number,
    to: Content,
    toOffset: number,
    note = '备注',
): IAnnotation {
    const annotation = muya.annotation.addFromSnapshot(
        snapshotOf(from, fromOffset, to, toOffset),
        note,
    );
    expect(annotation).not.toBeNull();
    return annotation!;
}

function highlightSpans(block: Content): HTMLElement[] {
    return [...block.domNode!.querySelectorAll<HTMLElement>('span.mu-annotation, span.mu-annotation-active')];
}

describe('标注高亮渲染', () => {
    it('未复制高亮：class 为 mu-annotation + data-index，正文文本一字不加', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        addAnnotation(muya, para!, 0, para!, QUOTE.length);

        const spans = highlightSpans(para!);
        expect(spans).toHaveLength(1);

        const [span] = spans;
        expect(span!.className).toBe('mu-annotation');
        expect(span!.dataset.index).toBe('1');
        expect(span!.dataset.copied).toBeUndefined();
        expect(span!.getAttribute('title')).toBe('备注');

        // 角标不是文本节点：span 里只有一个文本节点，内容就是引文本身。
        expect(span!.textContent).toBe(QUOTE);
        expect(span!.childNodes).toHaveLength(1);
        expect(span!.children).toHaveLength(0);

        // 更关键的全局不变量：整块渲染出来的文本与块源码逐字相同（序号没有混进正文）。
        expect(para!.domNode!.textContent).toBe(para!.text);
    });

    it('序号角标由样式表的 ::after 伪元素提供（CSS 侧断言）', () => {
        expect(indexCss).toContain('.mu-annotation[data-index]::after');
        expect(indexCss).toMatch(/\.mu-annotation\[data-index\]::after[^}]*content:\s*attr\(data-index\)/);
        expect(indexCss).toContain('.mu-annotation[data-copied]');
        expect(indexCss).toContain('.mu-annotation-active');

        // 保险：整块 DOM 里没有任何文本节点带有序号数字。
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        addAnnotation(muya, para!, 0, para!, QUOTE.length);

        const text = para!.domNode!.textContent ?? '';
        expect(text).not.toContain('1');
        expect(text).toBe(para!.text);
    });

    it('已复制态走 data-copied（class 不变）', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        annotation.copied = true;
        annotation.round = 1;
        annotation.sentQuote = annotation.anchor.quote;
        muya.annotation.setAnnotations(muya.annotation.list());

        const [span] = highlightSpans(para!);
        expect(span!.className).toBe('mu-annotation');
        expect(span!.dataset.copied).toBe('true');
        expect(span!.dataset.index).toBe('1');
    });

    it('激活态走 annotation-active class，取消后回到未激活态', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        muya.annotation.setActive(annotation.id);
        expect(highlightSpans(para!)[0]!.className).toBe('mu-annotation-active');
        expect(highlightSpans(para!)[0]!.dataset.index).toBe('1');

        muya.annotation.setActive(null);
        expect(highlightSpans(para!)[0]!.className).toBe('mu-annotation');
    });

    it('跨块标注：逐块画高亮，角标只画在首块', () => {
        const muya = bootMuya(DOC);
        const [, para, next] = contentBlocks(muya);
        addAnnotation(muya, para!, 14, next!, 3);

        const firstSpans = highlightSpans(para!);
        const tailSpans = highlightSpans(next!);
        expect(firstSpans).toHaveLength(1);
        expect(tailSpans).toHaveLength(1);

        expect(firstSpans[0]!.dataset.index).toBe('1');
        expect(tailSpans[0]!.dataset.index).toBeUndefined();
        expect(tailSpans[0]!.textContent).toBe(next!.text.slice(0, 3));
        expect(para!.domNode!.textContent).toBe(para!.text);
        expect(next!.domNode!.textContent).toBe(next!.text);
    });

    it('重叠标注：区间被切成不重叠的段，重叠区归序号更小的那条，正文不重复', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        const first = addAnnotation(muya, para!, 0, para!, QUOTE.length, '第一条');
        const second = addAnnotation(muya, para!, 4, para!, 18, '第二条');

        expect(first.anchor.ranges[0]).toMatchObject({ start: 0, end: QUOTE.length });
        expect(second.anchor.ranges[0]).toMatchObject({ start: 4, end: 18 });

        const spans = highlightSpans(para!);
        expect(spans).toHaveLength(2);
        expect(spans[0]!.dataset.index).toBe('1');
        expect(spans[0]!.textContent).toBe(para!.text.slice(0, QUOTE.length));
        expect(spans[1]!.dataset.index).toBe('2');
        expect(spans[1]!.textContent).toBe(para!.text.slice(QUOTE.length, 18));

        // 重叠区只画一次：整块文本仍是源码原文（这条能钉住 substring 参数交换的老坑）。
        expect(para!.domNode!.textContent).toBe(para!.text);
    });

    it('高亮常驻：裸的 block.update()（等价于一次按键后的重渲染）不掉高亮', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        addAnnotation(muya, para!, 0, para!, QUOTE.length);

        para!.update();
        expect(highlightSpans(para!)).toHaveLength(1);

        para!.update({ start: { offset: 0 }, end: { offset: 0 }, block: para! }, []);
        expect(highlightSpans(para!)).toHaveLength(1);
    });

    it('与搜索高亮并存（两套 class 互不清除）', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        addAnnotation(muya, para!, 0, para!, QUOTE.length);

        muya.editor.searchModule.search('权限');

        expect(highlightSpans(para!).length + highlightSpans(contentBlocks(muya)[2]!).length).toBe(1);
        expect(muya.domNode.querySelectorAll('span.mu-highlight, span.mu-selection').length).toBeGreaterThan(0);
        expect(muya.domNode.querySelectorAll('span.mu-annotation').length).toBe(1);
    });

    it('偏好关闭：高亮立刻擦掉，重新打开后回来（数据保留）', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        addAnnotation(muya, para!, 0, para!, QUOTE.length);

        muya.annotation.setEnabled(false);
        expect(highlightSpans(para!)).toHaveLength(0);
        expect(para!.domNode!.textContent).toBe(para!.text);
        expect(muya.annotation.list()).toHaveLength(1);

        muya.annotation.setEnabled(true);
        expect(highlightSpans(para!)).toHaveLength(1);
    });

    it('归档 / 失效的条目正文不画高亮', () => {
        const muya = bootMuya(DOC);
        const [, para, next] = contentBlocks(muya);
        const archived = addAnnotation(muya, para!, 0, para!, QUOTE.length, '已归档');
        const orphan = addAnnotation(muya, next!, 0, next!, 3, '失效');

        archived.archived = true;
        archived.archivedAt = Date.now();
        next!.text = '完全无关的一段文字。';
        muya.annotation.relocate();
        muya.annotation.setAnnotations(muya.annotation.list());

        expect(orphan.anchorState).toBe('orphaned');
        expect(highlightSpans(para!)).toHaveLength(0);
        expect(highlightSpans(next!)).toHaveLength(0);
    });
});
