// @vitest-environment happy-dom
import type { IHtmlBlockState, TState } from '../types';
import { describe, expect, it } from 'vitest';
import { MarkdownToState } from '../markdownToState';
import ExportMarkdown from '../stateToMarkdown';

// 内嵌 HTML 块的「外框尺寸落盘」：meta 序列化成块前面的一行 HTML 注释
// （`<!--momark-frame w=960 h=436 z=1-->`），解析时再摘回 state.meta。
//
// 三条底线由这些用例锁住：
// ① 没有 meta 的块输出与历史版本逐字节一致（老文档零影响）；
// ② 标记不能漏进块文本（渲染内容必须与没有标记时一致）；
// ③ markdown → state → markdown 跑两遍结果相同（保存一次不会持续改写文件）。
const OPTIONS = {
    footnote: false,
    math: true,
    isGitlabCompatibilityEnabled: false,
    trimUnnecessaryCodeBlockEmptyLines: false,
    frontMatter: true,
};

function toMarkdown(states: TState[]): string {
    return new ExportMarkdown({ listIndentation: 1 }).generate(states);
}

function toState(markdown: string): TState[] {
    return new MarkdownToState(OPTIONS).generate(markdown);
}

function roundTrip(markdown: string): string {
    return toMarkdown(toState(markdown));
}

function htmlBlock(states: TState[]): IHtmlBlockState {
    const state = states.find(node => node.name === 'html-block');

    if (!state || state.name !== 'html-block')
        throw new Error('expected an html-block state');

    return state;
}

describe('stateToMarkdown — 内嵌 HTML 块 meta', () => {
    it('有 meta 时在块内容前写一行注释', () => {
        const md = toMarkdown([
            { name: 'html-block', text: '<div>hi</div>', meta: { width: 960, height: 436, zoom: 1 } },
        ]);

        expect(md).toBe('<!--momark-frame w=960 h=436 z=1-->\n<div>hi</div>\n');
    });

    it('只写有值的键', () => {
        expect(toMarkdown([{ name: 'html-block', text: '<div>hi</div>', meta: { width: 800 } }]))
            .toBe('<!--momark-frame w=800-->\n<div>hi</div>\n');
    });

    it('多行块内容与注释一起原样输出', () => {
        const md = toMarkdown([
            { name: 'html-block', text: '<div>\n  <p>hi</p>\n</div>', meta: { width: 600, height: 300 } },
        ]);

        expect(md).toBe('<!--momark-frame w=600 h=300-->\n<div>\n  <p>hi</p>\n</div>\n');
    });

    it('没有 meta 的块输出与历史版本逐字节一致', () => {
        // meta 缺席与 meta 为空对象都必须走老路径（不写注释）。
        expect(toMarkdown([{ name: 'html-block', text: '<div>hi</div>' }])).toBe('<div>hi</div>\n');
        expect(toMarkdown([{ name: 'html-block', text: '<div>hi</div>', meta: {} }])).toBe('<div>hi</div>\n');
    });

    it('注释带块所在层级的缩进（列表 / 块引用里的块）', () => {
        const md = toMarkdown([
            {
                name: 'bullet-list',
                meta: { loose: true, marker: '-' },
                children: [
                    {
                        name: 'list-item',
                        children: [
                            { name: 'paragraph', text: 'a' },
                            { name: 'html-block', text: '<div>hi</div>', meta: { width: 800, height: 300 } },
                        ],
                    },
                ],
            },
        ]);

        expect(md).toBe('- a\n\n  <!--momark-frame w=800 h=300-->\n  <div>hi</div>\n');
    });
});

describe('markdownToState — 内嵌 HTML 块 meta', () => {
    it('解析注释：meta 正确，块文本不含注释', () => {
        const state = htmlBlock(toState('<!--momark-frame w=960 h=436 z=1-->\n<div>hi</div>\n'));

        expect(state.text).toBe('<div>hi</div>');
        expect(state.meta).toEqual({ width: 960, height: 436, zoom: 1 });
    });

    it('没有注释时 meta 为空对象，文本原样（老文档行为不变）', () => {
        const state = htmlBlock(toState('<div>hi</div>\n'));

        expect(state.text).toBe('<div>hi</div>');
        expect(state.meta).toEqual({});
    });

    it('注释虽然自成一段，也不会漏成空的 HTML 块或段落', () => {
        const states = toState('<!--momark-frame w=960-->\n<div>hi</div>\n');

        expect(states).toHaveLength(1);
        expect(states[0].name).toBe('html-block');
    });

    it('块引用 / 列表里的注释同样被摘掉并挂到块上', () => {
        const quoted = toState('> <!--momark-frame w=800 h=300-->\n> <div>hi</div>\n');
        const quotedBlock = quoted[0];

        expect(quotedBlock.name).toBe('block-quote');
        if (quotedBlock.name !== 'block-quote')
            throw new Error('expected a block-quote state');

        const inner = htmlBlock(quotedBlock.children);
        expect(inner.text).toBe('<div>hi</div>');
        expect(inner.meta).toEqual({ width: 800, height: 300 });
    });
});

describe('内嵌 HTML 块 meta round-trip', () => {
    const cases: [string, string][] = [
        ['单行块', '<!--momark-frame w=960 h=436 z=1-->\n<div>hi</div>\n'],
        ['多行块', '<!--momark-frame w=800 h=300-->\n<div>\n  <p>hi</p>\n</div>\n'],
        ['只带缩放', '<!--momark-frame z=1.25-->\n<div>hi</div>\n'],
        ['块引用里的块', '> <!--momark-frame w=800 h=300-->\n> <div>hi</div>\n'],
        ['列表里的块', '- a\n\n  <!--momark-frame w=800 h=300-->\n  <div>hi</div>\n'],
        ['没有 meta 的块', '<div>hi</div>\n'],
        ['普通注释不是尺寸标记', '<!-- 我的注释 -->\n<div>hi</div>\n'],
    ];

    for (const [name, md] of cases) {
        it(`${name}：markdown → state → markdown 稳定（跑两遍相同）`, () => {
            const first = roundTrip(md);

            expect(roundTrip(first)).toBe(first);
        });
    }

    it('state → markdown → state 保留 meta', () => {
        const states = toState('<!--momark-frame w=960 h=436 z=1.5-->\n<div>hi</div>\n');

        expect(htmlBlock(toState(toMarkdown(states))).meta).toEqual({ width: 960, height: 436, zoom: 1.5 });
    });
});
