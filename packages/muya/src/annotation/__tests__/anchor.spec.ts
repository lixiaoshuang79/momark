// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type TreeNode from '../../block/base/treeNode';
import type { Muya } from '../../muya';
import type { IAnnotation, TSelectionSnapshot } from '../types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya as MuyaEditor } from '../../muya';
import { diceCoefficient, normalizeText } from '../anchor';

// 锚点提取与四段式重定位（方案 §2.1 / §2.3）。
// 覆盖：同块与跨块锚点、四段命中分支、核对（sentQuote）、行号（跨块 + 行尾修正）、
// 以及「跳过光标所在块、blur 补做」的重定位节奏。

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
    vi.useRealTimers();
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
    note = '这段逻辑不通——角色不由用户自行切换',
): IAnnotation {
    const annotation = muya.annotation.addFromSnapshot(
        snapshotOf(from, fromOffset, to, toOffset),
        note,
    );
    expect(annotation).not.toBeNull();
    return annotation!;
}

describe('锚点提取', () => {
    it('同块选区：quote 取源码原文，prefix/suffix/块级与邻接兜底/章节路径齐全', () => {
        const muya = bootMuya(DOC);
        const [, para, next] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);
        const { anchor } = annotation;

        expect(anchor.quote).toBe(QUOTE);
        expect(anchor.ranges).toHaveLength(1);
        expect(anchor.ranges[0]).toMatchObject({
            blockPath: para!.path,
            blockName: para!.blockName,
            start: 0,
            end: QUOTE.length,
        });
        expect(anchor.prefix).toBe('');
        expect(anchor.suffix).toBe('，系统根据当前角色实时刷新权限。');
        expect(anchor.blockText).toBe(para!.text);
        expect(anchor.blockTextTail).toBeUndefined();
        // 邻接兜底取的是**源码**文本：标题块的 content 里连 `#` 一起存（getTOC 的
        // 口径也是从 raw 里剥标记），引文同理——这是"给 agent 看源码位置"的设计。
        expect(anchor.beforeBlockText).toBe('# 第一章 概述');
        expect(anchor.afterBlockText).toBe(next!.text.slice(0, 48));
        expect(anchor.blockPath).toEqual(para!.path);
        expect(anchor.headingPath).toEqual(['第一章 概述']);

        expect(annotation.anchorState).toBe('anchored');
        expect(annotation.copied).toBe(false);
        expect(annotation.archived).toBe(false);
        expect(annotation.currentText).toBe(QUOTE);
    });

    it('跨块选区：ranges 按文档顺序多段、quote 按 \\n 拼接、方向相反也归一', () => {
        const muya = bootMuya(DOC);
        const [, para, next] = contentBlocks(muya);
        const forward = addAnnotation(muya, para!, 14, next!, 3);
        const backward = addAnnotation(muya, next!, 3, para!, 14);

        for (const annotation of [forward, backward]) {
            const { anchor } = annotation;
            expect(anchor.quote).toBe(`${para!.text.slice(14)}\n${next!.text.slice(0, 3)}`);
            expect(anchor.ranges).toHaveLength(2);
            expect(anchor.ranges[0]).toMatchObject({ blockPath: para!.path, start: 14, end: para!.text.length });
            expect(anchor.ranges[1]).toMatchObject({ blockPath: next!.path, start: 0, end: 3 });
            expect(anchor.blockText).toBe(para!.text);
            expect(anchor.blockTextTail).toBe(next!.text);
            expect(anchor.suffix).toBe(next!.text.slice(3, 3 + 32));
            expect(anchor.afterBlockText).toBe('');
        }

        expect(forward.anchor.ranges).toEqual(backward.anchor.ranges);
    });

    it('空备注 / 空选区不落条目', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);

        expect(muya.annotation.addFromSnapshot(snapshotOf(para!, 0, para!, QUOTE.length), '   ')).toBeNull();
        expect(muya.annotation.addFromSnapshot(snapshotOf(para!, 3, para!, 3), '备注')).toBeNull();
        expect(muya.annotation.list()).toHaveLength(0);
    });
});

describe('四段式重定位', () => {
    it('第 1 段 原地精确：块内引文被移动 → 偏移重算，状态仍是 anchored', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        para!.text = `新增前缀${para!.text}`;
        muya.annotation.relocate();

        expect(annotation.anchorState).toBe('anchored');
        expect(annotation.anchor.ranges[0]).toMatchObject({ start: 4, end: 4 + QUOTE.length });
        expect(annotation.currentText).toBe(QUOTE);
        expect(para!.domNode!.querySelectorAll('span.mu-annotation')).toHaveLength(1);
    });

    it('第 2 段 全域精确：引文搬到别的块 → relocated 到新块新偏移', () => {
        const muya = bootMuya(DOC);
        const [, para, next] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        para!.text = '这里已经没有引文了。';
        next!.text = `第二段内容。${QUOTE}`;
        muya.annotation.relocate();

        expect(annotation.anchorState).toBe('relocated');
        expect(annotation.anchor.ranges).toHaveLength(1);
        expect(annotation.anchor.ranges[0]).toMatchObject({
            blockPath: next!.path,
            start: 6,
            end: 6 + QUOTE.length,
        });
        expect(annotation.currentText).toBe(QUOTE);
        expect(para!.domNode!.querySelectorAll('span.mu-annotation')).toHaveLength(0);
        expect(next!.domNode!.querySelectorAll('span.mu-annotation')).toHaveLength(1);
    });

    it('第 3 段 模糊匹配：引文被改了一个字 → relocated，currentText 是当前文本', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        para!.text = '用户可以在任意页面切换身份，系统根据当前角色实时刷新权限。';
        muya.annotation.relocate();

        expect(annotation.anchorState).toBe('relocated');
        const range = annotation.anchor.ranges[0]!;
        expect(range.blockPath).toEqual(para!.path);

        const current = para!.text.slice(range.start, range.end);
        expect(current).toContain('用户可以在任意页面切换');
        expect(annotation.currentText).toBe(current);
        expect(annotation.currentText).not.toBe(QUOTE);
    });

    it('第 4 段 失效：引文被整段替换 → orphaned，正文不再画高亮但记录保留', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);
        expect(para!.domNode!.querySelectorAll('span.mu-annotation')).toHaveLength(1);

        para!.text = '完全无关的一段文字。';
        muya.annotation.relocate();

        expect(annotation.anchorState).toBe('orphaned');
        expect(annotation.currentText).toBeUndefined();
        expect(annotation.note).toBe('这段逻辑不通——角色不由用户自行切换');
        expect(annotation.anchor.quote).toBe(QUOTE);
        expect(muya.annotation.highlightsFor(para!)).toHaveLength(0);
        expect(para!.domNode!.querySelectorAll('span.mu-annotation')).toHaveLength(0);
    });

    it('「已重定位」是粘性的：再次重定位不会退回 anchored', () => {
        const muya = bootMuya(DOC);
        const [, para, next] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        para!.text = '这里已经没有引文了。';
        next!.text = `第二段内容。${QUOTE}`;
        muya.annotation.relocate();
        expect(annotation.anchorState).toBe('relocated');

        // 第二次跑：位置已稳定，状态不该被改回 anchored（否则面板提示会自己消失）
        muya.annotation.relocate();
        expect(annotation.anchorState).toBe('relocated');
        expect(annotation.anchor.ranges[0]).toMatchObject({ blockPath: next!.path, start: 6 });
    });

    it('已复制条目：比对 sentQuote 写 contentChanged', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        annotation.copied = true;
        annotation.round = 1;
        annotation.sentQuote = annotation.anchor.quote;

        // 文本没变（只是位置移动）→ 内容未变化
        para!.text = `前缀${para!.text}`;
        muya.annotation.relocate();
        expect(annotation.contentChanged).toBe(false);

        // 引文本身被改 → 内容已变化
        para!.text = '用户可以在任意页面切换身份，系统根据当前角色实时刷新权限。';
        muya.annotation.relocate();
        expect(annotation.contentChanged).toBe(true);
    });

    it('重定位不改写引文与各层提示字段（锚点本体是快照）', () => {
        const muya = bootMuya(DOC);
        const [, para, next] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);
        const before = JSON.stringify({
            quote: annotation.anchor.quote,
            prefix: annotation.anchor.prefix,
            suffix: annotation.anchor.suffix,
            blockText: annotation.anchor.blockText,
            beforeBlockText: annotation.anchor.beforeBlockText,
            afterBlockText: annotation.anchor.afterBlockText,
            headingPath: annotation.anchor.headingPath,
        });

        para!.text = `这里已经没有引文了。`;
        next!.text = `第二段内容。${QUOTE}`;
        muya.annotation.relocate();

        expect(annotation.anchorState).toBe('relocated');
        expect(
            JSON.stringify({
                quote: annotation.anchor.quote,
                prefix: annotation.anchor.prefix,
                suffix: annotation.anchor.suffix,
                blockText: annotation.anchor.blockText,
                beforeBlockText: annotation.anchor.beforeBlockText,
                afterBlockText: annotation.anchor.afterBlockText,
                headingPath: annotation.anchor.headingPath,
            }),
        ).toBe(before);
    });
});

describe('findAtSnapshot', () => {
    it('选区完全落在标注内 / 折叠光标在高亮里 → 命中并置为激活；部分重叠或在外 → null', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        const inside = muya.annotation.findAtSnapshot(snapshotOf(para!, 2, para!, 6));
        expect(inside?.id).toBe(annotation.id);
        expect(muya.annotation.activeId).toBe(annotation.id);

        // 部分重叠（跨过标注右边界）不算命中
        expect(
            muya.annotation.findAtSnapshot(snapshotOf(para!, QUOTE.length - 2, para!, QUOTE.length + 2)),
        ).toBeNull();

        // 点正文高亮 → 折叠光标落在标注里，也应命中（卡片开编辑态）
        expect(muya.annotation.findAtSnapshot(snapshotOf(para!, 3, para!, 3))?.id).toBe(annotation.id);

        // 完全在标注之外
        expect(
            muya.annotation.findAtSnapshot(
                snapshotOf(para!, QUOTE.length + 5, para!, QUOTE.length + 7),
            ),
        ).toBeNull();
    });
});

describe('归一化与 2-gram Dice 工具（第 3 段模糊匹配的两块基石）', () => {
    it('normalizeText：去行内标记与零宽字符、折叠空白、全半角标点统一，并保留回原串的下标映射', () => {
        const raw = '**加粗** \u200B文字，好 ';
        const { text, map } = normalizeText(raw);

        expect(text).toBe('加粗 文字,好');
        expect(map).toHaveLength(text.length);
        expect(raw[map[0]!]).toBe('加');
        expect(raw[map[text.length - 1]!]).toBe('好');
    });

    it('diceCoefficient：相同为 1、无关为 0、一字之差仍在阈值之上', () => {
        const quote = '用户可以在任意页面切换角色';

        expect(diceCoefficient(quote, quote)).toBe(1);
        expect(diceCoefficient(quote, '完全不同的另一段文本内容')).toBe(0);
        expect(diceCoefficient(quote, '用户可以在任意页面切换身份')).toBeGreaterThan(0.75);
        expect(diceCoefficient('', quote)).toBe(0);
    });
});

describe('重定位节奏（json-change debounce / 跳过光标所在块 / blur 补做）', () => {
    it('debounce 400ms 后重定位，但跳过光标所在块，blur 时补做', () => {
        vi.useFakeTimers();
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        // 光标落在被标注的块里（正在这里打字）
        para!.setCursor(0, 0);
        expect(muya.editor.activeContentBlock).toBe(para);

        para!.text = `前缀${para!.text}`;
        muya.editor.jsonState.flush();
        vi.advanceTimersByTime(400);

        // 被跳过：偏移没有重算
        expect(annotation.anchor.ranges[0]!.start).toBe(0);

        // blur → 补做
        muya.eventCenter.emit('blur');
        expect(annotation.anchor.ranges[0]!.start).toBe(2);
    });

    it('光标不在被标注的块里时不跳过', () => {
        vi.useFakeTimers();
        const muya = bootMuya(DOC);
        const [heading, para] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        heading!.setCursor(0, 0);
        para!.text = `前缀${para!.text}`;
        muya.editor.jsonState.flush();
        vi.advanceTimersByTime(400);

        expect(annotation.anchor.ranges[0]!.start).toBe(2);
    });

    it('选区离开被跳过的块时补做（不必等 blur）', () => {
        vi.useFakeTimers();
        const muya = bootMuya(DOC);
        const [heading, para] = contentBlocks(muya);
        const annotation = addAnnotation(muya, para!, 0, para!, QUOTE.length);

        para!.setCursor(0, 0);
        para!.text = `前缀${para!.text}`;
        muya.editor.jsonState.flush();
        vi.advanceTimersByTime(400);
        expect(annotation.anchor.ranges[0]!.start).toBe(0);

        // 光标移出该块 → 立刻补做
        heading!.setCursor(0, 0);
        expect(annotation.anchor.ranges[0]!.start).toBe(2);
    });
});

describe('getExport', () => {
    it('list() 与 getExport() 同为文档顺序（桌面按位置对齐两者做面板序号）', () => {
        const muya = bootMuya(DOC);
        const [, para, next] = contentBlocks(muya);
        const later = addAnnotation(muya, next!, 0, next!, 3, '第二条');
        const earlier = addAnnotation(muya, para!, 0, para!, QUOTE.length, '第一条');

        expect(muya.annotation.list().map(annotation => annotation.note)).toEqual(['第一条', '第二条']);
        expect(muya.annotation.list().map(annotation => annotation.id)).toEqual([
            earlier.id,
            later.id,
        ]);
        expect(muya.annotation.getExport().map(item => item.note)).toEqual(['第一条', '第二条']);
    });

    it('按文档顺序出条目（失效排最后），index 从 1 起', () => {
        const muya = bootMuya(DOC);
        const [, para, next] = contentBlocks(muya);
        const later = addAnnotation(muya, next!, 0, next!, 3, '第二条');
        const earlier = addAnnotation(muya, para!, 0, para!, QUOTE.length, '第一条');

        const items = muya.annotation.getExport();
        expect(items.map(item => item.note)).toEqual(['第一条', '第二条']);
        expect(items.map(item => item.index)).toEqual([1, 2]);
        expect(earlier.id).not.toBe(later.id);
        expect(items[0]!.headingPath).toEqual(['第一章 概述']);
        expect(items[0]!.orphaned).toBe(false);
        expect(items[0]!.quote).toBe(QUOTE);
        expect(items[0]!.blockText).toBe(para!.text);
        expect(items[0]!.fragment).toBe(false);
        expect(items[1]!.note).toBe('第二条');

        // ids 子集：index 重新从 1 起
        expect(muya.annotation.getExport([later.id]).map(item => item.index)).toEqual([1]);
    });

    it('行号：跨块标注取首段 start 与末段 end 所在行', () => {
        const muya = bootMuya('段一文字。\n\n段二文字。\n');
        const [first, second] = contentBlocks(muya);
        const annotation = addAnnotation(muya, first!, 2, second!, 2);
        expect(annotation.anchor.quote).toBe('文字。\n段二');

        const [item] = muya.annotation.getExport();
        expect(item!.lineStart).toBe(1);
        expect(item!.lineEnd).toBe(3);
    });

    it('行号：引文正好在行尾结束（末段哨兵落在换行之后）回退一行', () => {
        const muya = bootMuya('第一行\n第二行\n');
        const [para] = contentBlocks(muya);
        expect(para!.text).toBe('第一行\n第二行');

        addAnnotation(muya, para!, 0, para!, 4); // 引文含行尾换行
        const [item] = muya.annotation.getExport();
        expect(item!.lineStart).toBe(1);
        expect(item!.lineEnd).toBe(1);
    });

    it('fragment：引文切断了行内标记时标为片段', () => {
        const muya = bootMuya('**角色**内容\n');
        const [para] = contentBlocks(muya);
        expect(para!.text).toBe('**角色**内容');

        addAnnotation(muya, para!, 3, para!, 8); // '色**内容'
        const [item] = muya.annotation.getExport();
        expect(item!.quote).toBe('色**内容');
        expect(item!.fragment).toBe(true);
    });
});
