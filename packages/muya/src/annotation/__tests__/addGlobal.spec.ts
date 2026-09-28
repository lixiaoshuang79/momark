// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type { Muya } from '../../muya';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Muya as MuyaEditor } from '../../muya';

// 全局备注（面板「＋ 全局备注」）：不锚定正文内容——ranges 为空、不进高亮、
// 不参与重定位；导出条目带 `global` 标志（复制文本据此写「全局备注」抬头）。

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

describe('全局备注 addGlobal', () => {
    it('建条 global 标注：ranges 空、不进高亮、导出带标志', () => {
        const muya = bootMuya(DOC);
        const annotation = muya.annotation.addGlobal('整篇语气再精简些');
        expect(annotation).not.toBeNull();
        expect(annotation!.global).toBe(true);
        expect(annotation!.anchor.ranges).toHaveLength(0);
        expect(annotation!.note).toBe('整篇语气再精简些');

        // 不进正文高亮。
        const [, para] = contentBlocks(muya);
        expect(muya.annotation.highlightsFor(para!)).toHaveLength(0);

        // 导出条目带 global 标志（复制文本据此写「全局备注」）。
        const items = muya.annotation.getExport();
        const item = items.find((i) => i.note === '整篇语气再精简些');
        expect(item?.global).toBe(true);
    });

    it('空备注返回 null', () => {
        const muya = bootMuya(DOC);
        expect(muya.annotation.addGlobal('   ')).toBeNull();
    });

    it('重定位不碰全局备注（外部改文档后仍 anchored、不转 orphaned）', () => {
        const muya = bootMuya(DOC);
        const annotation = muya.annotation.addGlobal('整篇意见');
        muya.annotation.relocate();
        const after = muya.annotation.list().find((a) => a.id === annotation!.id);
        expect(after?.anchorState).toBe('anchored');
    });
});
