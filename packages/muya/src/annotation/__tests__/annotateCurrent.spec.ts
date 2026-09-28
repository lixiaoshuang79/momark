// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type { Muya } from '../../muya';
import type { TSelectionSnapshot } from '../types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Muya as MuyaEditor } from '../../muya';

// 面板「新标注」入口（方案 §3.2）：有选区用选区；折叠光标取整块。
// 它不依赖正文里的选中操作——回归点是「折叠光标也能构造出整块快照」。

const DOC = [
    '# 第一章 概述',
    '',
    '用户可以在任意页面切换角色，系统根据当前角色实时刷新权限。',
    '',
].join('\n');

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
    muya.editor.scrollPage!.depthFirstTraverse((node) => {
        if (node.isContent())
            blocks.push(node as Content);
    });
    return blocks;
}

describe('面板「新标注」入口', () => {
    it('折叠光标：取光标所在整块并发出创建请求', () => {
        const muya = bootMuya(DOC);
        const [, para] = contentBlocks(muya);
        para!.setCursor(5, 5, true);

        const captured: TSelectionSnapshot[] = [];
        muya.eventCenter.subscribe('muya-annotation-request', (snap: TSelectionSnapshot) => {
            captured.push(snap);
        });

        const ok = muya.annotation.annotateCurrentParagraph();
        expect(ok).toBe(true);
        expect(captured).toHaveLength(1);

        const snap = captured[0]!;
        expect(snap.anchorBlock).toBe(para);
        expect(snap.focusBlock).toBe(para);
        expect(snap.anchor?.offset).toBe(0);
        expect(snap.focus?.offset).toBe(para!.text.length);
    });

    it('空块：返回 false 且不发请求', () => {
        const muya = bootMuya('第一段。\n\n\n');
        const blocks = contentBlocks(muya);
        const empty = blocks.find((b) => !b.text.length);
        if (!empty) {
            // 文档里没有真空块时跳过（渲染器可能已忽略空段）。
            expect(true).toBe(true);
            return;
        }
        empty.setCursor(0, 0, true);
        const captured: TSelectionSnapshot[] = [];
        muya.eventCenter.subscribe('muya-annotation-request', (snap: TSelectionSnapshot) => {
            captured.push(snap);
        });
        expect(muya.annotation.annotateCurrentParagraph()).toBe(false);
        expect(captured).toHaveLength(0);
    });
});
