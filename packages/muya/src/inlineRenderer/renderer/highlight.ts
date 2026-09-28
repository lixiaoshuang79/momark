import type Format from '../../block/base/format';
import type { H, IHighlightData, Token } from '../types';
import type Renderer from './index';
import { union } from '../../utils';

/** 序号缺省时排到最后（非首段的高亮没有角标序号）。 */
const NO_INDEX = Number.MAX_SAFE_INTEGER;

/**
 * `IHighlight.data` → snabbdom data。
 * - `index` → `data-index`（角标走 CSS `::after` + `attr(data-index)`，**不是文本节点**：
 *   真实文本节点会被 `selection/dom.ts` 的 DOM↔偏移映射算进正文长度，破坏选区）
 * - `copied` → `data-copied`（已复制态样式）
 * - `note` → `title`（原生 tooltip）
 */
function highlightVNodeData(data?: IHighlightData) {
    if (!data)
        return undefined;

    const dataset: Record<string, string> = {};
    const attrs: Record<string, string> = {};

    if (data.index != null)
        dataset.index = String(data.index);
    if (data.copied)
        dataset.copied = 'true';
    if (data.note)
        attrs.title = data.note;

    if (!Object.keys(dataset).length && !Object.keys(attrs).length)
        return undefined;

    return { dataset, attrs };
}

// change text to highlight vnode
export default function highlight(
    this: Renderer,
    h: H,
    block: Format,
    rStart: number,
    rEnd: number,
    token: Token,
) {
    const { text } = block;
    const { highlights } = token;
    let result = [];
    const unions = [];
    let pos = rStart;

    if (highlights) {
        for (const light of highlights) {
            const un = union({ start: rStart, end: rEnd }, light);
            if (un)
                unions.push(un);
        }
    }

    if (unions.length) {
        // 标注之间允许重叠（搜索高亮不会）。先按起点排序、同起点序号小者在前，再把
        // 后一条的起点夹到已画位置：保证输出区间两两不重叠——否则
        // `substring(pos, start)` 在 pos > start 时会交换参数，把正文重复吐一遍。
        unions.sort(
            (a, b) =>
                a.start - b.start || (a.data?.index ?? NO_INDEX) - (b.data?.index ?? NO_INDEX),
        );

        for (const u of unions) {
            const { end, active, type, data } = u;
            const start = Math.max(u.start, pos);

            if (end <= start)
                continue;

            if (pos < start)
                result.push(text.substring(pos, start));

            const className = this.getHighlightClassName(!!active, type);
            // 同一条标注在块内可能被内联格式（加粗等）切成多个 token 段：
            // 序号角标只画在第一段，后续段保留底色/已复制态与 tooltip。
            let vNodeData = highlightVNodeData(data);
            if (data?.index != null) {
                if (this._drawnAnnotationIndexes.has(data.index))
                    vNodeData = highlightVNodeData({ ...data, index: undefined });
                else
                    this._drawnAnnotationIndexes.add(data.index);
            }
            const content = text.substring(start, end);

            result.push(
                vNodeData
                    ? h(`span.${className}`, vNodeData, content)
                    : h(`span.${className}`, content),
            );
            pos = end;
        }

        if (pos < rEnd)
            result.push(block.text.substring(pos, rEnd));
    }
    else {
        result = [text.substring(rStart, rEnd)];
    }

    return result;
}
