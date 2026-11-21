import type { IAnnotationSnapshot, TInspectMatch } from './types';
import diff from 'fast-diff';

/**
 * 「标注时 ↔ 现在」的比对（纯函数，不依赖引擎实例；桌面直接走子路径引用）。
 *
 * 三个维度分开判，面板据此出「改了文字 / 改了格式 / 改了块类型」：
 *   - 文字：渲染后的纯文本（`plain`）变了；
 *   - 格式：纯文本没变、源码变了（加粗 / 行内代码 / 链接这类行内标记）；
 *   - 块：块类型或其属性变了（标题级别、列表 ↔ 段落、有序 ↔ 无序、引用、代码语言、
 *     任务勾选、表头 ↔ 表体）。
 * 只有标注段之外的上下文变了，算「无变化」但带 `context` 标记。
 */

export type TDiffOp = -1 | 0 | 1;

export interface IDiffSegment {
    op: TDiffOp;
    text: string;
}

export type TCompareStatus = 'unchanged' | 'changed' | 'rewritten' | 'deleted';

export interface ISnapshotComparison {
    status: TCompareStatus;
    text: boolean;
    format: boolean;
    block: boolean;
    context: boolean;
    /** 纯文本差异（文字有变化时才有）；过长或没有可比内容时为 null。 */
    diff: IDiffSegment[] | null;
}

/** 参与逐字比对的最大长度（fast-diff 是 O(ND)，再长的整段改写逐字标意义也不大）。 */
const DIFF_MAX = 4000;

const collapseSpace = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * 块级「样子」的指纹。v2 反推的近似快照没有容器信息，只比 kind/level，
 * 避免把「列表项 vs 段落」这种当年根本没记录的差异误报成改了块类型。
 */
export function styleKeyOf(snapshot: IAnnotationSnapshot, coarse = false): string {
    const { kind, level, lang, checked, cell, trail } = snapshot;
    if (coarse) {
        // v2 只知道「段落内容」，分不出它在列表 / 引用 / 任务项里：这几类视为同一种。
        const family = ['paragraph', 'list', 'task', 'quote', 'footnote'].includes(kind) ? 'text' : kind;
        return `${family}|${kind === 'heading' ? (level ?? '') : ''}`;
    }

    const listType = trail.includes('order-list') ? 'ol' : trail.includes('bullet-list') ? 'ul' : trail.includes('task-list') ? 'task' : '';

    return [
        kind,
        kind === 'heading' ? (level ?? '') : '',
        kind === 'code' ? (lang ?? '') : '',
        kind === 'task' ? String(!!checked) : '',
        kind === 'table' ? (cell?.row === 0 ? 'th' : 'td') : '',
        trail.includes('block-quote') ? 'quote' : '',
        listType,
    ].join('|');
}

/**
 * 逐字差异 + 轻量语义清理：夹在两处改动之间、短于 2 个字符的「相同」碎片并进改动
 * （否则中文改写会被切成一字一段的红绿斑马纹），再把相邻同类段合并、删在前增在后。
 */
export function diffText(before: string, after: string): IDiffSegment[] {
    const raw = diff(before, after).map(([op, text]) => ({ op: op as TDiffOp, text }));
    const segments: IDiffSegment[] = [];

    raw.forEach((segment, index) => {
        const isGap
            = segment.op === 0
                && index > 0
                && index < raw.length - 1
                && Array.from(segment.text).length < 2
                && raw[index - 1]!.op !== 0
                && raw[index + 1]!.op !== 0;

        if (isGap) {
            segments.push({ op: -1, text: segment.text }, { op: 1, text: segment.text });
            return;
        }
        segments.push(segment);
    });

    // 合并：一段连续改动区里所有删除拼一起、所有新增拼一起。
    const merged: IDiffSegment[] = [];
    let removed = '';
    let added = '';
    const flush = () => {
        if (removed)
            merged.push({ op: -1, text: removed });
        if (added)
            merged.push({ op: 1, text: added });
        removed = '';
        added = '';
    };

    for (const segment of segments) {
        if (segment.op === 0) {
            flush();
            const previous = merged[merged.length - 1];
            if (previous && previous.op === 0)
                previous.text += segment.text;
            else
                merged.push({ ...segment });
        }
        else if (segment.op === -1) {
            removed += segment.text;
        }
        else {
            added += segment.text;
        }
    }
    flush();

    return merged.filter(segment => segment.text);
}

/**
 * 比对一条历史标注的「标注时」与「现在」。
 *
 * `match`：`located` = 按原锚点找到了它现在的位置；`block` = 原句找不到、按原
 * 位置对应到了段落（整句改写）；`missing` = 原文已删除。
 */
export function compareSnapshots(
    origin: IAnnotationSnapshot,
    match: TInspectMatch,
    now: IAnnotationSnapshot | null,
): ISnapshotComparison {
    const result: ISnapshotComparison = {
        status: 'deleted',
        text: false,
        format: false,
        block: false,
        context: false,
        diff: null,
    };

    if (match === 'missing' || !now)
        return result;

    const coarse = !!origin.legacy || !!now.legacy;
    result.block = styleKeyOf(origin, coarse) !== styleKeyOf(now, coarse);

    const before = origin.plain;
    const after = now.plain;
    const diffable = before.length <= DIFF_MAX && after.length <= DIFF_MAX;

    if (match === 'block') {
        result.status = 'rewritten';
        result.text = true;
        // 原句 vs 整段：整段比原句长太多时逐字差异只剩一片绿，不如不给。
        if (diffable && after.length <= Math.max(before.length * 4, 200))
            result.diff = diffText(before, after);
        return result;
    }

    result.text = collapseSpace(before) !== collapseSpace(after);
    result.format = !result.text && origin.text !== now.text;
    result.context = !result.text && !result.format && !result.block && !coarse && origin.markdown !== now.markdown;
    result.status = result.text || result.format || result.block ? 'changed' : 'unchanged';

    if (result.text && diffable)
        result.diff = diffText(before, after);

    return result;
}
