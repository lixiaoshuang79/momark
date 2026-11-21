import type { IRenderToStaticHTMLOptions } from '../state/renderToStaticHTML';
import type { IAnnotationSnapshot } from './types';
import { renderToStaticHTML } from '../state/renderToStaticHTML';
import { SNAPSHOT_MARK_END, SNAPSHOT_MARK_START } from './snapshot';

/**
 * 快照 → 可直接 `v-html` 的安全 HTML（feat/annotation-history-compare）。
 *
 * 1. 在 `markStart/markEnd` 处插回哨兵，交给 `renderToStaticHTML`（同步、DOMPurify
 *    清洗，与导出同一套配置）渲染出块的真实外观；
 * 2. 在渲染结果的 DOM 里找到两个哨兵，把它们之间的文本逐个文本节点包进
 *    `<mark class="mu-snap-mark">`，再摘掉哨兵。
 *
 * 第 2 步只在**清洗之后**做、只新增 `<mark>` 元素和删字符，不会引入新的不可信
 * 内容。哨兵在代码高亮里可能被切成几个 token、落在不同文本节点——所以按「所有
 * 文本节点拼起来的全局偏移」找，而不是逐个节点找。
 */

export const SNAPSHOT_MARK_CLASS = 'mu-snap-mark';

/** 这些元素下的空白文本节点是排版缩进，包进 `<mark>` 会产出非法结构（表格里乱跳）。 */
const STRUCTURAL = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'UL', 'OL']);

interface ITextSlice {
    node: Text;
    start: number;
}

function collectText(root: Node): ITextSlice[] {
    const doc = root.ownerDocument ?? document;
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const slices: ITextSlice[] = [];
    let offset = 0;
    let node = walker.nextNode() as Text | null;

    while (node) {
        slices.push({ node, start: offset });
        offset += node.data.length;
        node = walker.nextNode() as Text | null;
    }

    return slices;
}

/** 按全局偏移删掉 `[from, from+length)`（可能跨多个文本节点）。 */
function deleteGlobal(slices: ITextSlice[], from: number, length: number): void {
    const to = from + length;
    for (const { node, start } of slices) {
        const end = start + node.data.length;
        if (end <= from || start >= to)
            continue;
        const a = Math.max(from, start) - start;
        const b = Math.min(to, end) - start;
        node.deleteData(a, b - a);
    }
}

function wrapGlobal(root: Node, from: number, to: number): void {
    const doc = root.ownerDocument ?? document;
    // 删字符后偏移变了，重新收集一遍。
    const slices = collectText(root);

    for (const { node, start } of slices) {
        const end = start + node.data.length;
        if (end <= from || start >= to)
            continue;
        const parent = node.parentNode as Element | null;
        if (!parent || STRUCTURAL.has(parent.nodeName))
            continue;

        let target = node;
        const a = Math.max(from, start) - start;
        const b = Math.min(to, end) - start;
        if (!target.data.slice(a, b).trim())
            continue;
        if (b < target.data.length)
            target.splitText(b);
        if (a > 0)
            target = target.splitText(a);

        const mark = doc.createElement('mark');
        mark.className = SNAPSHOT_MARK_CLASS;
        parent.insertBefore(mark, target);
        mark.appendChild(target);
    }
}

export function renderSnapshotHtml(
    snapshot: Pick<IAnnotationSnapshot, 'markdown' | 'markStart' | 'markEnd' | 'kind'>,
    options: IRenderToStaticHTMLOptions = {},
): string {
    const { markdown, markStart, markEnd } = snapshot;
    if (!markdown)
        return '';

    const marked
        = markStart >= 0 && markEnd >= markStart && markEnd <= markdown.length && snapshot.kind !== 'math';
    const source = marked
        ? markdown.slice(0, markStart)
        + SNAPSHOT_MARK_START
        + markdown.slice(markStart, markEnd)
        + SNAPSHOT_MARK_END
        + markdown.slice(markEnd)
        : markdown;

    const html = renderToStaticHTML(source, options);
    if (!marked)
        return html;

    const template = document.createElement('template');
    template.innerHTML = html;
    const root = template.content;

    const full = collectText(root).map(slice => slice.node.data).join('');
    const startAt = full.indexOf(SNAPSHOT_MARK_START);
    const endAt = full.indexOf(SNAPSHOT_MARK_END);

    // 先删后面的哨兵，前面的偏移不受影响。
    if (endAt >= 0)
        deleteGlobal(collectText(root), endAt, SNAPSHOT_MARK_END.length);
    if (startAt >= 0)
        deleteGlobal(collectText(root), startAt, SNAPSHOT_MARK_START.length);

    if (startAt >= 0 && endAt > startAt)
        wrapGlobal(root, startAt, endAt - SNAPSHOT_MARK_START.length);

    // 哨兵若落进了属性（比如切在链接 URL 中间），文本里找不到它——序列化后整体
    // 再摘一遍（纯字母串，split/join 不涉及替换串语义）。
    return template.innerHTML.split(SNAPSHOT_MARK_START).join('').split(SNAPSHOT_MARK_END).join('');
}
