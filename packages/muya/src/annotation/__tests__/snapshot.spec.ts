// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type TreeNode from '../../block/base/treeNode';
import type { Muya } from '../../muya';
import type { IAnnotation, TSelectionSnapshot } from '../types';
import { afterEach, describe, expect, it } from 'vitest';
import { Muya as MuyaEditor } from '../../muya';
import { captureSnapshot, legacySnapshot, originSnapshotOf, plainOfQuote } from '../snapshot';
import { compareSnapshots } from '../snapshotCompare';

// 标注样式快照（feat/annotation-history-compare）：
// 新建时拍「标注时」快照、inspect() 给出「现在」、外部改写后的三态（命中 / 段落对应 / 删除）、
// v2 旧条目的反推快照。

const DOC = [
    '# 星野阅读器',
    '',
    '## 1. 登录与引导',
    '',
    '本版本把首次启动的引导压缩为三步，**不再强制登录**，用户可以先用本地模式体验完整阅读流程。',
    '',
    '> 设计取舍：引导可跳过，但跳过入口放在步骤二之后。',
    '',
    '- `⌘ K` 打开命令面板',
    '- `Esc` 关闭当前浮层',
    '',
    '| 状态 | 触发条件 | 期望表现 |',
    '| --- | --- | --- |',
    '| 未登录 | 首次启动 | 显示本地模式入口 |',
    '| 已登录 | 完成授权 | 同步书架与阅读进度 |',
    '',
    '```ts',
    'type ReaderMode = \'scroll\' | \'page\'',
    '```',
    '',
    '1. 本地写入成功即视为完成',
    '2. 后台排队上传',
    '',
    '同步失败不阻塞阅读，失败项进入重试队列。',
    '',
].join('\n');

const booted: Muya[] = [];

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
        if (node.isContent() && node.blockName !== 'language-input')
            blocks.push(node);
    });
    return blocks;
}

function findBlock(muya: Muya, needle: string): Content {
    const block = contentBlocks(muya).find(item => item.text.includes(needle));
    if (!block)
        throw new Error(`block not found: ${needle}`);
    return block;
}

function annotate(muya: Muya, needle: string, quote = needle): IAnnotation {
    const block = findBlock(muya, needle);
    const start = block.text.indexOf(quote);
    const snapshot: TSelectionSnapshot = {
        anchor: { offset: start, block, path: block.path },
        focus: { offset: start + quote.length, block, path: block.path },
        anchorBlock: block,
        focusBlock: block,
        anchorPath: block.path,
        focusPath: block.path,
    };
    const annotation = muya.annotation.addFromSnapshot(snapshot, '改一下');
    expect(annotation).not.toBeNull();
    return annotation!;
}

function marked(snapshot: { markdown: string; markStart: number; markEnd: number }) {
    return snapshot.markdown.slice(snapshot.markStart, snapshot.markEnd);
}

describe('标注时快照（origin）', () => {
    it('新建即拍：段落保留行内格式，区间正好是引文', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '**不再强制登录**');
        const origin = annotation.origin!;

        expect(origin.kind).toBe('paragraph');
        expect(origin.text).toBe('**不再强制登录**');
        expect(origin.plain).toBe('不再强制登录');
        expect(marked(origin)).toBe('**不再强制登录**');
        expect(origin.markdown).toContain('本版本把首次启动的引导压缩为三步');
        expect(origin.legacy).toBeUndefined();
    });

    it('标题：记录级别，markdown 带井号', () => {
        const muya = bootMuya(DOC);
        const origin = annotate(muya, '1. 登录与引导').origin!;

        expect(origin).toMatchObject({ kind: 'heading', level: 2, trail: ['atx-heading'] });
        expect(origin.markdown).toBe('## 1. 登录与引导');
        expect(marked(origin)).toBe('1. 登录与引导');
    });

    it('列表：只留命中项，保留列表语境', () => {
        const muya = bootMuya(DOC);
        const origin = annotate(muya, '关闭当前浮层').origin!;

        expect(origin.kind).toBe('list');
        expect(origin.trail).toEqual(['bullet-list', 'list-item', 'paragraph']);
        expect(origin.markdown).toBe('- `Esc` 关闭当前浮层');
    });

    it('有序列表：只留命中项，编号与原文一致', () => {
        const muya = bootMuya(DOC);
        const origin = annotate(muya, '后台排队上传').origin!;

        expect(origin.trail[0]).toBe('order-list');
        expect(origin.markdown).toBe('2. 后台排队上传');
    });

    it('表格：表头 + 命中行，记录行列', () => {
        const muya = bootMuya(DOC);
        const origin = annotate(muya, '同步书架与阅读进度').origin!;

        expect(origin.kind).toBe('table');
        expect(origin.cell).toEqual({ row: 2, col: 2 });
        expect(origin.markdown).toContain('状态');
        expect(origin.markdown).toContain('已登录');
        expect(origin.markdown).not.toContain('未登录');
        expect(marked(origin)).toBe('同步书架与阅读进度');
    });

    it('引用与代码块', () => {
        const muya = bootMuya(DOC);
        const quote = annotate(muya, '引导可跳过').origin!;
        const code = annotate(muya, 'ReaderMode').origin!;

        expect(quote.kind).toBe('quote');
        expect(quote.markdown.startsWith('> ')).toBe(true);
        expect(code).toMatchObject({ kind: 'code', lang: 'ts' });
        expect(code.markdown.startsWith('```ts')).toBe(true);
        expect(marked(code)).toBe('ReaderMode');
    });

    it('引文切在 ** 中间：哨兵挪到定界符外，不拆坏加粗', () => {
        const muya = bootMuya(DOC);
        const block = findBlock(muya, '不再强制登录');
        const at = block.text.indexOf('**不再');
        // 区间 [at+1, …) 落在 `**` 中间
        const snapshot = captureSnapshot(
            [{ blockPath: block.path, blockName: block.blockName, start: at + 1, end: at + 8 }],
            muya,
        )!;

        expect(snapshot.markdown).toContain('**不再强制登录**');
        expect(snapshot.markStart).toBe(snapshot.markdown.indexOf('**不再'));
    });
});

describe('inspect()：现在的样子', () => {
    it('未改动 → located，比对为 unchanged', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '1. 登录与引导');
        annotation.archived = true;

        const [result] = muya.annotation.inspect([annotation.id]);
        expect(result!.match).toBe('located');
        expect(compareSnapshots(annotation.origin!, result!.match, result!.snapshot).status).toBe('unchanged');
    });

    it('外部改写：标题升级、加粗去掉、改字、删段——各自给出对应的现在', () => {
        const muya = bootMuya(DOC);
        const heading = annotate(muya, '1. 登录与引导');
        const bold = annotate(muya, '**不再强制登录**');
        const cell = annotate(muya, '同步书架与阅读进度');
        const gone = annotate(muya, '同步失败不阻塞阅读，失败项进入重试队列。');
        for (const item of [heading, bold, cell, gone])
            item.archived = true;

        const next = DOC
            .replace('## 1. 登录与引导', () => '### 1. 登录与引导')
            .replace('**不再强制登录**', () => '不再强制登录')
            .replace('同步书架与阅读进度', () => '同步书架、笔记与阅读进度')
            .replace('同步失败不阻塞阅读，失败项进入重试队列。\n', () => '');
        muya.replaceContent(next);

        const results = new Map(muya.annotation.inspect().map(result => [result.id, result]));

        const h = results.get(heading.id)!;
        const hc = compareSnapshots(heading.origin!, h.match, h.snapshot);
        expect(h.snapshot!.level).toBe(3);
        expect(hc).toMatchObject({ status: 'changed', block: true, text: false });

        const b = results.get(bold.id)!;
        const bc = compareSnapshots(bold.origin!, b.match, b.snapshot);
        expect(b.match).toBe('located');
        expect(bc).toMatchObject({ status: 'changed', format: true, text: false });

        const c = results.get(cell.id)!;
        const cc = compareSnapshots(cell.origin!, c.match, c.snapshot);
        expect(c.match).toBe('located');
        expect(cc.status).toBe('changed');
        expect(cc.text).toBe(true);
        expect(cc.diff!.some(segment => segment.op === 1 && segment.text.includes('笔记'))).toBe(true);

        const g = results.get(gone.id)!;
        expect(g.match).toBe('missing');
        expect(compareSnapshots(gone.origin!, g.match, g.snapshot).status).toBe('deleted');
    });

    it('整句改写（相似度跌破阈值）→ 按原位置对应到段落（block），不误报删除', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '失败项进入重试队列');
        annotation.archived = true;

        muya.replaceContent(DOC.replace('同步失败不阻塞阅读，失败项进入重试队列。', () => '上传出错时静默重试，最多三次后提醒。'));
        const [result] = muya.annotation.inspect([annotation.id]);

        expect(result!.match).toBe('block');
        // 定位用：原来所在的段落现在的块路径
        expect((muya.editor.scrollPage!.queryBlock([...result!.blockPath!]) as Content).text).toBe('上传出错时静默重试，最多三次后提醒。');
        expect(result!.snapshot!.markdown).toBe('上传出错时静默重试，最多三次后提醒。');
        expect(result!.snapshot!.markStart).toBe(-1);
        expect(compareSnapshots(annotation.origin!, result!.match, result!.snapshot).status).toBe('rewritten');
    });

    it('整块标注（单元格 / 整段）被改写 → 仍按命中处理、整块画区间，给出逐字差异', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '同步失败不阻塞阅读，失败项进入重试队列。');
        annotation.archived = true;

        muya.replaceContent(DOC.replace('同步失败不阻塞阅读，失败项进入重试队列。', () => '上传出错时静默重试，最多三次后提醒。'));
        const [result] = muya.annotation.inspect([annotation.id]);
        const comparison = compareSnapshots(annotation.origin!, result!.match, result!.snapshot);

        expect(result!.match).toBe('located');
        expect(marked(result!.snapshot!)).toBe('上传出错时静默重试，最多三次后提醒。');
        expect(comparison).toMatchObject({ status: 'changed', text: true });
        expect(comparison.diff!.length).toBeGreaterThan(0);
    });

    it('检视只读：归档条目在副本上重定位，不改写锚点、不广播（不触发落盘）', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '后台排队上传');
        annotation.archived = true;
        const events: unknown[] = [];
        muya.eventCenter.subscribe('annotation-change', (payload: unknown) => events.push(payload));

        muya.replaceContent(DOC.replace('2. 后台排队上传', () => '2. 立即后台排队上传'));
        const before = JSON.stringify(annotation.anchor);
        const stateBefore = annotation.anchorState;
        const [result] = muya.annotation.inspect([annotation.id]);

        // 「现在」的位置在结果里（定位用），条目本身原样不动
        expect(result!.match).toBe('located');
        const range = result!.ranges![0]!;
        const block = muya.editor.scrollPage!.queryBlock([...range.blockPath]) as Content;
        expect(block.text.slice(range.start, range.end)).toBe('后台排队上传');
        expect(JSON.stringify(annotation.anchor)).toBe(before);
        expect(annotation.anchorState).toBe(stateBefore);
        expect(events).toHaveLength(0);
    });

    it('全局备注不在结果里', () => {
        const muya = bootMuya(DOC);
        const global = muya.annotation.addGlobal('整体再精简')!;
        global.archived = true;

        expect(muya.annotation.inspect()).toEqual([]);
    });
});

describe('ensureOrigins()', () => {
    it('只给原样命中的旧条目补拍；文字已变的不补', () => {
        const muya = bootMuya(DOC);
        const intact = annotate(muya, '后台排队上传');
        const edited = annotate(muya, '本地写入成功即视为完成');
        delete intact.origin;
        delete edited.origin;

        findBlock(muya, '本地写入成功').text = '本地写入成功就算完成';
        muya.annotation.relocate();

        expect(muya.annotation.ensureOrigins([intact.id, edited.id])).toBe(1);
        const byId = (id: string) => muya.annotation.list().find(item => item.id === id)!;
        expect(byId(intact.id).origin?.markdown).toBe('2. 后台排队上传');
        expect(byId(edited.id).origin).toBeUndefined();
    });
});

describe('getExport 带 id', () => {
    it('导出项与条目 id 对应', () => {
        const muya = bootMuya(DOC);
        const a = annotate(muya, '后台排队上传');
        const b = annotate(muya, '1. 登录与引导');

        const items = muya.annotation.getExport([a.id, b.id]);
        expect(items.map(item => item.id)).toEqual([b.id, a.id]);
    });
});

describe('v2 旧条目反推（legacySnapshot）', () => {
    const base = (overrides: Partial<IAnnotation['anchor']>): IAnnotation => ({
        id: 'legacy',
        anchor: {
            ranges: [{ blockPath: [0, 'text'], blockName: 'paragraph.content', start: 0, end: 1 }],
            quote: '',
            prefix: '',
            suffix: '',
            blockText: '',
            beforeBlockText: '',
            afterBlockText: '',
            blockPath: [0, 'text'],
            headingPath: [],
            ...overrides,
        },
        note: 'n',
        copied: true,
        archived: true,
        anchorState: 'anchored',
        createdAt: 1,
        updatedAt: 1,
    });

    it('段落：按 prefix 定位区间', () => {
        const snapshot = legacySnapshot(base({ quote: '加粗', prefix: '前面**', blockText: '加粗 前面**加粗**' }))!;
        expect(snapshot.legacy).toBe(true);
        expect(snapshot.markStart).toBe('加粗 前面**'.length);
        expect(marked(snapshot)).toBe('加粗');
    });

    it('标题与表格单元格', () => {
        const heading = legacySnapshot(base({
            quote: '键盘操作',
            blockText: '### 1.1 键盘操作',
            ranges: [{ blockPath: [0, 'text'], blockName: 'atxheading.content', start: 8, end: 12 }],
        }))!;
        expect(heading).toMatchObject({ kind: 'heading', level: 3 });
        expect(marked(heading)).toBe('键盘操作');

        const cell = legacySnapshot(base({
            quote: '首次启动',
            blockText: '首次启动',
            ranges: [{ blockPath: [0, 'text'], blockName: 'table.cell.content', start: 0, end: 4 }],
        }))!;
        expect(cell.kind).toBe('table');
        expect(cell.markdown).toBe('| 首次启动 |\n| --- |');
        expect(marked(cell)).toBe('首次启动');
    });

    it('有真快照优先用真快照；全局备注没有快照', () => {
        const annotation = base({ quote: 'x', blockText: 'x' });
        expect(originSnapshotOf(annotation)!.legacy).toBe(true);
        const global = { ...base({}), global: true };
        expect(originSnapshotOf(global)).toBeNull();
    });

    it('旧快照 vs 新快照：只粗比块类型，不把「当年没记录的列表语境」误报成改了块', () => {
        const legacy = legacySnapshot(base({ quote: '后台排队上传', blockText: '后台排队上传' }))!;
        const muya = bootMuya(DOC);
        const now = captureSnapshot([{ ...annotate(muya, '后台排队上传').anchor.ranges[0]! }], muya)!;

        expect(now.kind).toBe('list');
        // legacy 的 paragraph 其实是「容器未知」：与 list 粗比视为同类
        expect(compareSnapshots(legacy, 'located', now)).toMatchObject({ status: 'unchanged', block: false, text: false });
    });
});

describe('plainOfQuote', () => {
    it('去行内标记、去标题井号', () => {
        expect(plainOfQuote('## **标题** `x`', 'heading')).toBe('标题 x');
        expect(plainOfQuote('`code` 保留', 'code')).toBe('`code` 保留');
    });
});
