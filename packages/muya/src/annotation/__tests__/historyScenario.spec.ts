// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type TreeNode from '../../block/base/treeNode';
import type { Muya } from '../../muya';
import type { IAnnotation, TSelectionSnapshot } from '../types';
import { afterEach, describe, expect, it } from 'vitest';
import { Muya as MuyaEditor } from '../../muya';
import { compareSnapshots } from '../snapshotCompare';

// 验收场景（任务书 §七）的引擎层走查：样本文档上 12 处不同格式位置标注 →
// 外部编辑器改文字 / 改格式 / 改块类型 / 删一处 / 整句改写 → 重载 → inspect()
// 每条都能拿到「标注时」与「现在」，并分出有变化 / 无变化 / 已删除。
// 文档内容与 fixtures/样本文档.md 一致（内联，测试不依赖仓库外路径）。

const SAMPLE = `# 星野阅读器 · 交互评审稿

## 1. 登录与引导

本版本把首次启动的引导压缩为三步，**不再强制登录**，用户可以先用本地模式体验完整阅读流程。引导只在首次启动出现，之后从「设置 → 通用」重新打开。

> 设计取舍：引导可跳过，但跳过入口放在步骤二之后，避免用户在还没理解产品价值时直接离开。

### 1.1 键盘操作

- \`⌘ K\` 打开命令面板
- \`⌘ /\` 查看快捷键
- \`Esc\` 关闭当前浮层

### 1.2 状态对照

| 状态 | 触发条件 | 期望表现 |
| --- | --- | --- |
| 未登录 | 首次启动 | 显示本地模式入口 |
| 已登录 | 完成授权 | 同步书架与阅读进度 |

## 2. 阅读界面

正文区域采用单栏排版，行宽 68 个字符。**页边批注**在宽屏下默认展开，窄屏收起为图标；图标上显示未读批注数量。

\`\`\`ts
type ReaderMode = 'scroll' | 'page'

const defaultMode: ReaderMode = 'scroll'
\`\`\`

> 批注与划线共用同一套锚点；删除原文后，批注进入历史并标记失效。

### 2.1 批注历史

每一轮批注在复制给外部工具后归档。历史里保留当轮的全部批注，允许恢复单条，也允许整组删除。当前版本只保留引文与备注，不记录批注发起时的排版样式。

## 3. 数据与同步

同步采用增量队列，冲突时以本地最后修改时间为准。**同步失败不阻塞阅读**，失败项进入重试队列，最多重试三次。

1. 本地写入成功即视为完成
2. 后台排队上传
3. 连续失败后提示用户手动重试
`;

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

function annotate(muya: Muya, quote: string, within = quote): IAnnotation {
    let target: Content | null = null;
    muya.editor.scrollPage!.depthFirstTraverse((node: TreeNode) => {
        if (!target && node.isContent() && node.blockName !== 'language-input' && node.text.includes(within))
            target = node;
    });
    const block = target! as Content;
    const start = block.text.indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0);
    const snapshot: TSelectionSnapshot = {
        anchor: { offset: start, block, path: block.path },
        focus: { offset: start + quote.length, block, path: block.path },
        anchorBlock: block,
        focusBlock: block,
        anchorPath: block.path,
        focusPath: block.path,
    };
    const annotation = muya.annotation.addFromSnapshot(snapshot, `改：${quote}`)!;
    expect(annotation.origin).toBeTruthy();
    return annotation;
}

describe('验收场景：一轮 12 条标注，外部修改后逐条对比', () => {
    it('改文字 / 改格式 / 改块类型 / 删除 / 未改动 各自分得清', () => {
        const muya = bootMuya(SAMPLE);
        const a = {
            h2: annotate(muya, '1. 登录与引导'),
            bold: annotate(muya, '**不再强制登录**'),
            quote: annotate(muya, '引导可跳过'),
            h3: annotate(muya, '1.1 键盘操作'),
            inlineCode: annotate(muya, '`⌘ K`'),
            esc: annotate(muya, '关闭当前浮层'),
            cell: annotate(muya, '显示本地模式入口'),
            cellHead: annotate(muya, '期望表现'),
            code: annotate(muya, 'defaultMode'),
            margin: annotate(muya, '**页边批注**'),
            history: annotate(muya, '不记录批注发起时的排版样式'),
            retry: annotate(muya, '连续失败后提示用户手动重试'),
        };
        expect(Object.keys(a)).toHaveLength(12);
        // 「复制」：归档进历史（store.copyAll 做的事，这里只需 archived）
        for (const item of Object.values(a))
            item.archived = true;

        // 外部编辑器里的修改（函数式替换，内容里没有 $ 也照规矩写）
        const edited = SAMPLE
            .replace('## 1. 登录与引导', () => '### 1. 登录与引导') // 块类型
            .replace('**不再强制登录**', () => '不再强制登录') // 格式
            .replace('`Esc` 关闭当前浮层', () => '`Esc` 关闭所有浮层') // 短引文改两个字
            .replace('显示本地模式入口', () => '显示本地模式与登录入口') // 单元格改字
            .replace('const defaultMode: ReaderMode = \'scroll\'', () => 'const defaultMode: ReaderMode = \'page\'') // 代码
            .replace('**页边批注**', () => '`页边批注`') // 加粗 → 行内代码
            .replace('当前版本只保留引文与备注，不记录批注发起时的排版样式。', () => '') // 删掉一句
            .replace('3. 连续失败后提示用户手动重试\n', () => ''); // 删掉一个列表项
        muya.replaceContent(edited);

        const results = new Map(muya.annotation.inspect().map(r => [r.id, r]));
        expect(results.size).toBe(12);
        const status = (item: IAnnotation) => {
            const r = results.get(item.id)!;
            return compareSnapshots(item.origin!, r.match, r.snapshot);
        };

        expect(status(a.h2)).toMatchObject({ status: 'changed', block: true, text: false });
        expect(results.get(a.h2.id)!.snapshot!.level).toBe(3);
        expect(status(a.bold)).toMatchObject({ status: 'changed', format: true, text: false });
        expect(status(a.quote).status).toBe('unchanged');
        expect(status(a.h3).status).toBe('unchanged');
        expect(status(a.inlineCode).status).toBe('unchanged');
        expect(status(a.cellHead).status).toBe('unchanged');

        // 短引文改两个字：靠前后文夹出现在的那一段，给精确区间与逐字差异
        const esc = status(a.esc);
        expect(esc).toMatchObject({ status: 'changed', text: true });
        expect(results.get(a.esc.id)!.snapshot!.text).toBe('关闭所有浮层');
        expect(esc.diff).toEqual([
            { op: 0, text: '关闭' },
            { op: -1, text: '当前' },
            { op: 1, text: '所有' },
            { op: 0, text: '浮层' },
        ]);

        // 整格标注被改长：模糊命中只是等长窗口，「现在」要取整格，差异才准
        const cell = status(a.cell);
        expect(cell).toMatchObject({ status: 'changed', text: true });
        expect(results.get(a.cell.id)!.snapshot!.kind).toBe('table');
        expect(results.get(a.cell.id)!.snapshot!.text).toBe('显示本地模式与登录入口');
        expect(cell.diff).toEqual([
            { op: 0, text: '显示本地模式' },
            { op: 1, text: '与登录' },
            { op: 0, text: '入口' },
        ]);
        // 改的是引文之外的 'scroll'：引文本身没变 → 未改动，但标出「上下文有改动」
        expect(status(a.code)).toMatchObject({ status: 'unchanged', context: true });
        expect(status(a.margin)).toMatchObject({ status: 'changed', format: true });

        // 段落还在、这一句被删了：判删除，并带回所在段落做语境
        expect(status(a.history).status).toBe('deleted');
        const historyNow = results.get(a.history.id)!;
        expect(historyNow.match).toBe('missing');
        expect(historyNow.snapshot!.markdown).toContain('也允许整组删除。');
        expect(historyNow.snapshot!.markStart).toBe(-1);
        expect(status(a.retry).status).toBe('deleted');
    });
});
