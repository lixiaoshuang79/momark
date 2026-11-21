// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type TreeNode from '../../block/base/treeNode';
import type { Muya } from '../../muya';
import type { IAnnotation, TSelectionSnapshot } from '../types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya as MuyaEditor } from '../../muya';
import { relocateAnnotation } from '../anchor';
import { DocIndex } from '../docIndex';
import { findReplacementBlock } from '../snapshot';
import { ANNOTATION_CLASS_NAMES } from '../types';

// 历史条目点击定位（feat/annotation-history-compare 第二轮）：
// reveal() 把归档条目「现在」的位置滚到视野里并闪烁一次；整句改写 / 这一句被删
// 指到原段落，连段落也没了退到原位置附近，什么都找不到给出 none——都不改写条目、
// 不广播、不落盘。另外覆盖 inspect() 的只读与缓存。

const DOC = [
    '# 星野阅读器',
    '',
    '## 1. 登录与引导',
    '',
    '本版本把首次启动的引导压缩为三步，**不再强制登录**，用户可以先用本地模式体验完整阅读流程。',
    '',
    '- `⌘ K` 打开命令面板',
    '- `Esc` 关闭当前浮层',
    '',
    '```ts',
    'const defaultMode = \'scroll\'',
    '```',
    '',
    '历史里保留当轮的全部批注。当前版本只保留引文与备注。',
    '',
    '同步失败不阻塞阅读，失败项进入重试队列。',
    '',
    '结尾段落。',
    '',
].join('\n');

const FLASH = `.${ANNOTATION_CLASS_NAMES.MU_ANNOTATION_FLASH}`;
const FLASH_BLOCK = `.${ANNOTATION_CLASS_NAMES.MU_ANNOTATION_FLASH_BLOCK}`;

const booted: Muya[] = [];
let scrolled: Element[] = [];

beforeEach(() => {
    scrolled = [];
    // happy-dom 的 scrollIntoView 是空实现：记录「滚到了谁」。
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
        scrolled.push(this);
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

function findBlock(muya: Muya, needle: string): Content {
    let found: Content | null = null;
    muya.editor.scrollPage!.depthFirstTraverse((node: TreeNode) => {
        if (!found && node.isContent() && node.blockName !== 'language-input' && node.text.includes(needle))
            found = node;
    });
    if (!found)
        throw new Error(`block not found: ${needle}`);
    return found;
}

function annotate(muya: Muya, quote: string, archived = true): IAnnotation {
    const block = findBlock(muya, quote);
    const start = block.text.indexOf(quote);
    const snapshot: TSelectionSnapshot = {
        anchor: { offset: start, block, path: block.path },
        focus: { offset: start + quote.length, block, path: block.path },
        anchorBlock: block,
        focusBlock: block,
        anchorPath: block.path,
        focusPath: block.path,
    };
    const annotation = muya.annotation.addFromSnapshot(snapshot, '改一下')!;
    expect(annotation).toBeTruthy();
    annotation.archived = archived;
    return annotation;
}

function flashText(muya: Muya): string {
    return [...muya.domNode.querySelectorAll(FLASH)].map(node => node.textContent).join('');
}

describe('reveal()：历史条目定位到正文', () => {
    it('命中：滚到标注段现在的位置并闪烁该段；条目不被改写、不广播', () => {
        vi.useFakeTimers();
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '失败项进入重试队列');
        const events: unknown[] = [];
        muya.eventCenter.subscribe('annotation-change', (payload: unknown) => events.push(payload));

        // 前面插入一段：位置挪了，原记录的块路径已经指不到它
        muya.replaceContent(DOC.replace('结尾段落。', () => '结尾段落。\n\n补充一段。').replace('# 星野阅读器', () => '# 星野阅读器\n\n新的导语。'));
        const before = JSON.stringify(annotation.anchor);

        const result = muya.annotation.reveal(annotation.id);

        expect(result.status).toBe('range');
        expect(result.inspection?.match).toBe('located');
        expect(flashText(muya)).toBe('失败项进入重试队列');
        expect(scrolled).toHaveLength(1);
        expect(scrolled[0]!.matches(FLASH)).toBe(true);
        expect(JSON.stringify(annotation.anchor)).toBe(before);
        expect(events).toHaveLength(0);

        // 一次性：到时自动消失
        vi.advanceTimersByTime(3600);
        expect(muya.domNode.querySelector(FLASH)).toBeNull();
    });

    it('高亮开关关闭时同样能闪烁（用户是在面板里主动点的定位）', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '不再强制登录');
        muya.annotation.setEnabled(false);

        expect(muya.annotation.reveal(annotation.id).status).toBe('range');
        expect(flashText(muya)).toBe('不再强制登录');
    });

    it('与当前列表的标注重叠：闪烁段完整画出，其余部分仍是原标注', () => {
        const muya = bootMuya(DOC);
        const live = annotate(muya, '首次启动的引导压缩为三步', false);
        const archived = annotate(muya, '引导压缩');

        muya.annotation.reveal(archived.id);
        expect(flashText(muya)).toBe('引导压缩');
        const rest = [...muya.domNode.querySelectorAll(`.${ANNOTATION_CLASS_NAMES.MU_ANNOTATION}`)]
            .map(node => node.textContent)
            .join('');
        expect(rest).toBe('首次启动的为三步');
        expect(live.archived).toBe(false);
    });

    it('整句改写：闪烁原来所在的段落（整块）', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '失败项进入重试队列');
        muya.replaceContent(DOC.replace('同步失败不阻塞阅读，失败项进入重试队列。', () => '上传出错时静默重试，最多三次后提醒。'));

        const result = muya.annotation.reveal(annotation.id);

        expect(result.status).toBe('block');
        const outlined = muya.domNode.querySelector(FLASH_BLOCK)!;
        expect(outlined.textContent).toContain('上传出错时静默重试');
        expect(scrolled[0]).toBe(outlined);
        expect(muya.domNode.querySelector(FLASH)).toBeNull();
    });

    it('这一句从段落里被删掉：指到原来的段落（context）', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '当前版本只保留引文与备注。');
        muya.replaceContent(DOC.replace('当前版本只保留引文与备注。', () => ''));

        const result = muya.annotation.reveal(annotation.id);

        expect(result.inspection?.match).toBe('missing');
        expect(result.status).toBe('context');
        expect(muya.domNode.querySelector(FLASH_BLOCK)!.textContent).toBe('历史里保留当轮的全部批注。');
    });

    it('整段被删：退到原来的相邻段落（near）', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '失败项进入重试队列');
        muya.replaceContent(DOC.replace('同步失败不阻塞阅读，失败项进入重试队列。\n\n', () => ''));

        const result = muya.annotation.reveal(annotation.id);

        expect(result.inspection?.match).toBe('missing');
        expect(result.status).toBe('near');
        expect(muya.domNode.querySelector(FLASH_BLOCK)!.textContent).toContain('当前版本只保留引文与备注');
        expect(scrolled).toHaveLength(1);
    });

    it('列表项整条被删：退到相邻列表项，框画在整条 <li> 上', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '关闭当前浮层');
        muya.replaceContent(DOC.replace('- `Esc` 关闭当前浮层\n', () => ''));

        const result = muya.annotation.reveal(annotation.id);

        expect(result.status).toBe('near');
        const outlined = muya.domNode.querySelector(FLASH_BLOCK)!;
        expect(outlined.tagName).toBe('LI');
        expect(outlined.textContent).toContain('打开命令面板');
    });

    it('原文与前后邻居都没了：none，不滚动也不留闪烁', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '失败项进入重试队列');
        muya.replaceContent('# 全新的文档\n\n完全不同的内容。\n');

        const result = muya.annotation.reveal(annotation.id);

        expect(result.status).toBe('none');
        expect(scrolled).toHaveLength(0);
        expect(muya.domNode.querySelector(FLASH)).toBeNull();
        expect(muya.domNode.querySelector(FLASH_BLOCK)).toBeNull();
    });

    it('全局备注：global，不滚动', () => {
        const muya = bootMuya(DOC);
        const global = muya.annotation.addGlobal('整体再精简')!;
        global.archived = true;

        expect(muya.annotation.reveal(global.id).status).toBe('global');
        expect(muya.annotation.reveal('no-such-id').status).toBe('none');
        expect(scrolled).toHaveLength(0);
    });

    it('代码块里的标注（不走行内高亮）：命中但画整块框', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, 'defaultMode');

        const result = muya.annotation.reveal(annotation.id);

        expect(result.status).toBe('range');
        const outlined = muya.domNode.querySelector(FLASH_BLOCK)!;
        expect(outlined).toBeTruthy();
        expect(outlined.textContent).toContain('defaultMode');
        expect(outlined.tagName).toBe('PRE');
    });

    it('v2 旧条目（没有 origin）同样可以定位', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '打开命令面板');
        delete annotation.origin;

        expect(muya.annotation.reveal(annotation.id).status).toBe('range');
        expect(flashText(muya)).toBe('打开命令面板');
    });

    it('正文一改就收掉闪烁；再点另一条会换掉上一条的闪烁', () => {
        const muya = bootMuya(DOC);
        const a = annotate(muya, '打开命令面板');
        const b = annotate(muya, '不再强制登录');

        muya.annotation.reveal(a.id);
        muya.annotation.reveal(b.id);
        expect(flashText(muya)).toBe('不再强制登录');

        muya.replaceContent(DOC.replace('结尾段落。', () => '结尾段落改了。'));
        expect(muya.domNode.querySelector(FLASH)).toBeNull();
    });
});

describe('inspect()：只读 + 缓存', () => {
    it('段尾那句被删（前后文在块边界上命中空区间）判删除，不判「已修改成空」', () => {
        const muya = bootMuya('开头的句子。中间要标注的句子。结尾的句子。\n\n下一段。\n');
        const annotation = annotate(muya, '结尾的句子。');
        muya.replaceContent('开头的句子。中间要标注的句子。\n\n下一段。\n');

        const [result] = muya.annotation.inspect([annotation.id]);
        expect(result!.match).not.toBe('located');
    });

    it('重复文本：原段落被删后，检视不会把归档锚点搬到另一处并写回', () => {
        const doc = '重复出现的一句话。\n\n中间一段。\n\n重复出现的一句话。\n\n结尾段。\n';
        const muya = bootMuya(doc);
        let second: Content | null = null;
        muya.editor.scrollPage!.depthFirstTraverse((node: TreeNode) => {
            if (node.isContent() && node.text === '重复出现的一句话。')
                second = node;
        });
        const block = second! as Content;
        const annotation = muya.annotation.addFromSnapshot({
            anchor: { offset: 0, block, path: block.path },
            focus: { offset: block.text.length, block, path: block.path },
            anchorBlock: block,
            focusBlock: block,
            anchorPath: block.path,
            focusPath: block.path,
        }, '改')!;
        annotation.archived = true;
        const before = JSON.stringify(annotation.anchor.ranges);

        muya.replaceContent('重复出现的一句话。\n\n中间一段。\n\n结尾段。\n');
        muya.annotation.inspect([annotation.id]);

        expect(JSON.stringify(annotation.anchor.ranges)).toBe(before);
    });

    it('文档没变：直接复用上次的结果；别处被编辑：已定位的条目仍复用；自己所在块被编辑：重算', () => {
        const muya = bootMuya(DOC);
        const annotation = annotate(muya, '打开命令面板');

        const [first] = muya.annotation.inspect([annotation.id]);
        const [again] = muya.annotation.inspect([annotation.id]);
        expect(again).toBe(first);

        muya.replaceContent(DOC.replace('结尾段落。', () => '结尾段落改了。'));
        const [elsewhere] = muya.annotation.inspect([annotation.id]);
        expect(elsewhere).toBe(first);

        muya.replaceContent(DOC.replace('结尾段落。', () => '结尾段落改了。').replace('打开命令面板', () => '打开全局命令面板'));
        const [own] = muya.annotation.inspect([annotation.id]);
        expect(own).not.toBe(first);
        expect(own!.snapshot!.text).toBe('打开全局命令面板');
    });

    it('共享索引与逐条检索结果逐条一致（精确 / 移动 / 模糊 / 段落对应 / 删除）', () => {
        // 伪随机汉字拼出互不相同的段落，模糊匹配才有意义
        const pool = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光';
        let seed = 7;
        const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
        const sentence = (n: number) => Array.from({ length: n }, () => pool[Math.floor(rand() * pool.length)]).join('');
        const paragraphs = Array.from({ length: 240 }, (_, i) => `${sentence(18)}，${sentence(14)}。第${i}段。`);
        const muya = bootMuya(`${paragraphs.join('\n\n')}\n`);
        const items = [10, 20, 30, 40, 50, 60].map(i => annotate(muya, paragraphs[i]!.slice(2, 24)));

        const edited = [...paragraphs];
        edited[30] = edited[30]!.slice(0, 8) + edited[30]!.slice(10); // 改两个字 → 模糊
        edited[40] = `${sentence(30)}。`; // 整段改写
        edited.splice(50, 1); // 删掉
        edited.splice(3, 0, '插入的一段新内容。'); // 其余整体下移
        muya.replaceContent(`${edited.join('\n\n')}\n`);

        const index = new DocIndex(muya.editor.scrollPage!);
        for (const item of items) {
            const plain = structuredClone(item);
            const shared = structuredClone(item);
            relocateAnnotation(plain, muya);
            relocateAnnotation(shared, muya, index);
            expect(shared.anchor.ranges).toEqual(plain.anchor.ranges);
            expect(shared.anchorState).toBe(plain.anchorState);
            expect(findReplacementBlock(item, muya, index)).toBe(findReplacementBlock(item, muya));
        }

        const results = new Map(muya.annotation.inspect().map(result => [result.id, result]));
        expect(results.get(items[0]!.id)!.match).toBe('located');
        expect(results.get(items[2]!.id)!.match).toBe('located');
        expect(results.get(items[4]!.id)!.match).not.toBe('located');
    });
});
