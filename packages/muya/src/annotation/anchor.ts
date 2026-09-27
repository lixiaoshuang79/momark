import type Content from '../block/base/content';
import type Parent from '../block/base/parent';
import type TreeNode from '../block/base/treeNode';
import type { ScrollPage } from '../block/scrollPage';
import type { TBlockPath } from '../block/types';
import type { Muya } from '../muya';
import type { TState } from '../state/types';
import type { Nullable } from '../types';
import type { IAnnotation, IAnnotationAnchor, IAnnotationRange, TSelectionSnapshot } from './types';
import { tokenizer, tokensToPlainText } from '../inlineRenderer/lexer';

/**
 * 标注锚点：选区 → 多层锚点（方案 §2.1）、四段式重定位（方案 §2.3）、
 * 归一化与 2-gram Dice 工具、批量行号（方案 §5.6）。
 *
 * 两条硬约束：
 * - 引文（`quote`）存的是**源码原文**（块内 raw markdown 切片，跨块按 `\n` 拼接），
 *   重定位只改写 `ranges`，`quote` 与各层提示字段是快照、永不回写。
 * - 所有对块树的查询都走 `scrollPage` + 块路径，不缓存块引用（外部重载后块对象全换）。
 */

/** 模糊匹配阈值：2-gram Dice 低于此值判为失效（方案 §2.3 第 3 段）。 */
const FUZZY_THRESHOLD = 0.75;
/** prefix / suffix 消歧长度。 */
const CONTEXT_LENGTH = 32;
/** 前 / 后邻接块兜底文本长度。 */
const NEIGHBOR_LENGTH = 48;
/** 单个块内最多枚举的候选位置数（防止超长文档上病态重复文本拖慢重定位）。 */
const MAX_OCCURRENCES = 64;
/** 跨块收集的块数上限。 */
const MAX_RANGE_BLOCKS = 4096;
/** 行号哨兵前缀：纯 ASCII，避免被 markdown 解析器吞掉或与正文撞车。 */
const LINE_SENTINEL_PREFIX = 'mUyAnnoLine';

/** 归一化时剔除的行内标记符号。 */
const INLINE_MARKER_RE = /[*_`~]/;
/** 归一化时剔除的零宽字符（零宽空格/连接符/方向标记/BOM/词连接符）。 */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF]/;
/** 归一化：全角标点 → 半角。 */
const FULLWIDTH_PUNCT: Record<string, string> = {
    '，': ',',
    '。': '.',
    '、': ',',
    '？': '?',
    '！': '!',
    '：': ':',
    '；': ';',
    '（': '(',
    '）': ')',
    '【': '[',
    '】': ']',
    '「': '"',
    '」': '"',
    '『': '"',
    '』': '"',
    '“': '"',
    '”': '"',
    '‘': '\'',
    '’': '\'',
};

interface IHeadingBlock extends Parent {
    meta?: { level: number };
}

interface IQuoteCandidate {
    block: Content;
    index: number;
}

interface IFuzzyHit {
    block: Content;
    start: number;
    end: number;
    score: number;
}

/** 块路径的字符串键（数组不能直接做 Map 键）。 */
export function pathKey(path: TBlockPath): string {
    return JSON.stringify(path);
}

export function samePath(a: TBlockPath, b: TBlockPath): boolean {
    return pathKey(a) === pathKey(b);
}

/**
 * 归一化：去零宽字符、去行内标记符号（`* _ ` ~`）、折叠空白、全半角标点统一。
 * 返回值同时给出 `map`——归一化文本第 i 个字符在原串中的下标，用于把模糊命中
 * 的区间映射回真实偏移（折叠空白时指向该空白之后的字符）。
 */
export function normalizeText(text: string): { text: string; map: number[] } {
    const chars: string[] = [];
    const map: number[] = [];
    let pendingSpace = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        if (ZERO_WIDTH_RE.test(char))
            continue;
        if (/\s/.test(char)) {
            pendingSpace = chars.length > 0;
            continue;
        }
        if (INLINE_MARKER_RE.test(char))
            continue;
        if (pendingSpace) {
            chars.push(' ');
            map.push(i);
            pendingSpace = false;
        }
        chars.push(FULLWIDTH_PUNCT[char] ?? char);
        map.push(i);
    }

    return { text: chars.join(''), map };
}

/** 2-gram 计数表。 */
function gramCounts(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (let i = 0; i + 1 < text.length; i++) {
        const gram = text.slice(i, i + 2);
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
}

/** 2-gram Dice 系数（0–1）。两个串都短于 2 字符时退化为相等判断。 */
export function diceCoefficient(a: string, b: string): number {
    if (!a || !b)
        return 0;
    if (a.length < 2 || b.length < 2)
        return a === b ? 1 : 0;

    const gramsA = gramCounts(a);
    const gramsB = gramCounts(b);
    let intersection = 0;
    let totalA = 0;
    let totalB = 0;

    for (const [gram, countA] of gramsA) {
        totalA += countA;
        const countB = gramsB.get(gram);
        if (countB !== undefined)
            intersection += Math.min(countA, countB);
    }
    for (const countB of gramsB.values())
        totalB += countB;

    return (2 * intersection) / (totalA + totalB);
}

/**
 * 在 `text` 上滑动定长窗口，返回与 `quoteGrams` 交集最大的窗口起点。
 * 交集数用滚动计数维护（进入/离开各一个 2-gram），单块成本 O(n)。
 */
function bestWindow(
    quoteGrams: Map<string, number>,
    text: string,
    size: number,
): { start: number; inter: number } {
    const window = new Map<string, number>();
    let inter = 0;

    const add = (gram: string) => {
        const count = (window.get(gram) ?? 0) + 1;
        window.set(gram, count);
        const quoteCount = quoteGrams.get(gram);
        if (quoteCount !== undefined && count <= quoteCount)
            inter++;
    };
    const remove = (gram: string) => {
        const count = (window.get(gram) ?? 0) - 1;
        if (count <= 0)
            window.delete(gram);
        else
            window.set(gram, count);
        const quoteCount = quoteGrams.get(gram);
        if (quoteCount !== undefined && count < quoteCount)
            inter--;
    };

    for (let i = 0; i + 1 < size; i++)
        add(text.slice(i, i + 2));

    let best = { start: 0, inter };
    for (let start = 1; start + size <= text.length; start++) {
        add(text.slice(start + size - 2, start + size));
        remove(text.slice(start - 1, start + 1));
        if (inter > best.inter)
            best = { start, inter };
    }

    return best;
}

/** 模糊匹配尝试的窗口长度：引文归一化长度的 0.9 / 1.0 / 1.1 倍。 */
function windowSizes(length: number): number[] {
    const sizes = new Set<number>();
    for (const ratio of [0.9, 1, 1.1]) {
        const size = Math.max(2, Math.round(length * ratio));
        if (size >= 2)
            sizes.add(size);
    }
    return [...sizes];
}

function resolveContentBlock(scrollPage: ScrollPage, path: TBlockPath): Nullable<Content> {
    // `queryBlock` 会就地 shift 传入的路径数组，必须给副本。
    const block = scrollPage.queryBlock([...path]);
    return block && block.isContent() ? block : null;
}

function contentBlocksOf(scrollPage: ScrollPage): Content[] {
    const blocks: Content[] = [];
    scrollPage.depthFirstTraverse((node: TreeNode) => {
        if (node.isContent())
            blocks.push(node);
    });
    return blocks;
}

/** 内容块路径 → 文档顺序序号（首个内容块为 0）。 */
export function blockOrdinalMap(muya: Muya): Map<string, number> {
    const map = new Map<string, number>();
    const { scrollPage } = muya.editor;
    if (!scrollPage)
        return map;

    let ordinal = 0;
    scrollPage.depthFirstTraverse((node: TreeNode) => {
        if (node.isContent())
            map.set(pathKey(node.path), ordinal++);
    });
    return map;
}

function topLevelAncestor(block: Content): Nullable<TreeNode> {
    let node: Nullable<TreeNode> = block;
    while (node && node.parent && !node.parent.isScrollPage)
        node = node.parent;
    return node;
}

/** 标题块的纯文本（口径与 `state/getTOC.ts` 一致）。 */
function headingPlainText(heading: IHeadingBlock, muya: Muya): string {
    const head = heading.children.head as Nullable<Content>;
    const text = head?.text ?? '';
    const source
        = heading.blockName === 'setext-heading'
            ? text.trim()
            : text.replace(/^\s*#{1,6}\s+/, '').trim();
    const { superSubScript, footnote } = muya.options;

    return tokensToPlainText(
        tokenizer(source, { hasBeginRules: false, options: { superSubScript, footnote } }),
    ).trim();
}

/** 章节路径快照，如 `['第三章 需求说明', '3.2 权限模型']`。 */
export function headingPathOf(block: Content, muya: Muya): string[] {
    const { scrollPage } = muya.editor;
    if (!scrollPage)
        return [];

    const target = topLevelAncestor(block);
    if (!target)
        return [];

    const stack: { level: number; text: string }[] = [];
    for (const node of scrollPage.children.iterator()) {
        if (node === target)
            break;
        if (node.blockName !== 'atx-heading' && node.blockName !== 'setext-heading')
            continue;

        const heading = node as IHeadingBlock;
        const level = heading.meta?.level ?? 1;
        while (stack.length && stack[stack.length - 1]!.level >= level)
            stack.pop();
        stack.push({ level, text: headingPlainText(heading, muya) });
    }

    return stack.map(item => item.text).filter(Boolean);
}

/** 块文本 → 渲染后的纯文本（判断引文是否切断了行内标记用）。 */
export function plainTextOf(text: string, muya: Muya): string {
    const { superSubScript, footnote } = muya.options;

    return tokensToPlainText(
        tokenizer(text, { hasBeginRules: false, options: { superSubScript, footnote } }),
    );
}

function neighborText(block: Content, direction: 'previous' | 'next'): string {
    const neighbor
        = direction === 'previous' ? block.previousContentInContext() : block.nextContentInContext();

    return neighbor ? neighbor.text.slice(0, NEIGHBOR_LENGTH) : '';
}

function rangeOf(block: Content, start: number, end: number): IAnnotationRange {
    return {
        blockPath: [...block.path],
        blockName: block.blockName,
        start: Math.max(0, start),
        end: Math.max(0, end),
    };
}

/**
 * 沿 `next` / `previous` 收集 `from → to` 之间的内容块（含两端）。
 * 找不到 `to`（两端不在同一条链上）时返回 null。
 */
function collectRangeBlocks(
    from: Content,
    to: Content,
    step: 'next' | 'previous',
): Nullable<Content[]> {
    const blocks: Content[] = [from];
    let node: Nullable<Content> = from;
    let guard = 0;

    while (node && node !== to && guard++ < MAX_RANGE_BLOCKS) {
        node = step === 'next' ? node.nextContentInContext() : node.previousContentInContext();
        if (node)
            blocks.push(node);
    }

    return node === to ? blocks : null;
}

function buildCrossBlockRanges(
    blocks: Content[],
    startOffset: number,
    endOffset: number,
): IAnnotationRange[] {
    const ranges: IAnnotationRange[] = [];

    blocks.forEach((block, index) => {
        const start = index === 0 ? startOffset : 0;
        const end = index === blocks.length - 1 ? endOffset : block.text.length;
        if (end > start)
            ranges.push(rangeOf(block, start, end));
    });

    return ranges;
}

/**
 * 选区快照 → 标注定位段（跨块按文档顺序多段）。方向已归一（anchor 在后时自动交换），
 * 两端不在同一条内容链上（理论上不会发生）时返回空数组。
 */
export function selectionToRanges(snap: TSelectionSnapshot): IAnnotationRange[] {
    const anchorBlock = snap.anchorBlock ?? snap.anchor?.block;
    const focusBlock = snap.focusBlock ?? snap.focus?.block;
    if (!anchorBlock || !focusBlock)
        return [];

    const anchorOffset = snap.anchor?.offset ?? 0;
    const focusOffset = snap.focus?.offset ?? 0;

    if (anchorBlock === focusBlock) {
        const start = Math.min(anchorOffset, focusOffset);
        const end = Math.max(anchorOffset, focusOffset);
        return end > start ? [rangeOf(anchorBlock, start, end)] : [];
    }

    const forward = collectRangeBlocks(anchorBlock, focusBlock, 'next');
    if (forward)
        return buildCrossBlockRanges(forward, anchorOffset, focusOffset);

    const backward = collectRangeBlocks(anchorBlock, focusBlock, 'previous');
    if (backward)
        return buildCrossBlockRanges([...backward].reverse(), focusOffset, anchorOffset);

    return [];
}

/**
 * 锚点提取：由定位段生成 `quote` / `prefix` / `suffix` / 块级与邻接兜底文本 /
 * 章节路径。任一段的块解析不到时返回 null（调用方据此判失败）。
 */
export function extractAnchor(
    ranges: IAnnotationRange[],
    muya: Muya,
): Nullable<IAnnotationAnchor> {
    const { scrollPage } = muya.editor;
    if (!scrollPage || !ranges.length)
        return null;

    const blocks = ranges.map(range => resolveContentBlock(scrollPage, range.blockPath));
    if (blocks.some(block => !block))
        return null;

    const first = ranges[0]!;
    const last = ranges[ranges.length - 1]!;
    const firstBlock = blocks[0]!;
    const lastBlock = blocks[blocks.length - 1]!;
    const quote = ranges
        .map((range, index) => blocks[index]!.text.slice(range.start, range.end))
        .join('\n');

    if (!quote)
        return null;

    return {
        ranges: ranges.map(range => ({ ...range, blockPath: [...range.blockPath] })),
        quote,
        prefix: firstBlock.text.slice(Math.max(0, first.start - CONTEXT_LENGTH), first.start),
        suffix: lastBlock.text.slice(last.end, last.end + CONTEXT_LENGTH),
        blockText: firstBlock.text,
        blockTextTail: ranges.length > 1 ? lastBlock.text : undefined,
        beforeBlockText: neighborText(firstBlock, 'previous'),
        afterBlockText: neighborText(lastBlock, 'next'),
        blockPath: [...first.blockPath],
        headingPath: headingPathOf(firstBlock, muya),
    };
}

/** 选区是否完全落在某条标注的定位段内（`findAtSnapshot` 用）。 */
export function rangesContainSelection(
    ranges: IAnnotationRange[],
    selection: IAnnotationRange[],
): boolean {
    if (!ranges.length || !selection.length)
        return false;

    const head = ranges[0]!;
    const tail = ranges[ranges.length - 1]!;
    const selectionHead = selection[0]!;
    const selectionTail = selection[selection.length - 1]!;

    if (!samePath(head.blockPath, selectionHead.blockPath))
        return false;
    if (!samePath(tail.blockPath, selectionTail.blockPath))
        return false;

    return head.start <= selectionHead.start && tail.end >= selectionTail.end;
}

/** 折叠光标（点正文高亮）落在某条标注的某一段内（含两端）。 */
export function rangesContainOffset(
    ranges: IAnnotationRange[],
    blockPath: TBlockPath,
    offset: number,
): boolean {
    return ranges.some(
        range => samePath(range.blockPath, blockPath) && offset >= range.start && offset <= range.end,
    );
}

/** 快照里的折叠光标点（`findAtSnapshot` 的退化分支用）。 */
export function caretPointOf(
    snapshot: TSelectionSnapshot,
): Nullable<{ blockPath: TBlockPath; offset: number }> {
    const block = snapshot.anchorBlock ?? snapshot.anchor?.block;
    if (!block)
        return null;

    return { blockPath: [...block.path], offset: snapshot.anchor?.offset ?? 0 };
}

/** 引文是否切断了行内标记（引文不是所在块纯文本的子串）。 */
export function isFragmentQuote(annotation: IAnnotation, muya: Muya): boolean {
    const { quote, blockText } = annotation.anchor;
    if (!quote)
        return false;

    const target = quote.split('\n')[0] ?? quote;

    return !plainTextOf(blockText, muya).includes(target);
}

/** 多个候选里挑最像原位置的一个（prefix/suffix → 块名 → 章节 → 索引距离）。 */
function pickOccurrence(text: string, annotation: IAnnotation): number {
    const { quote, prefix, suffix, ranges } = annotation.anchor;
    const positions: number[] = [];
    let at = text.indexOf(quote);

    while (at > -1 && positions.length < MAX_OCCURRENCES) {
        positions.push(at);
        at = text.indexOf(quote, at + 1);
    }

    if (!positions.length)
        return -1;
    if (positions.length === 1)
        return positions[0]!;

    const original = ranges[0]?.start ?? 0;
    let best = positions[0]!;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const position of positions) {
        let score = 0;
        if (prefix && text.slice(Math.max(0, position - prefix.length), position) === prefix)
            score += 2;
        if (
            suffix
            && text.slice(position + quote.length, position + quote.length + suffix.length) === suffix
        ) {
            score += 2;
        }
        score -= Math.min(Math.abs(position - original), 100) / 100;
        if (score > bestScore) {
            bestScore = score;
            best = position;
        }
    }

    return best;
}

function collectQuoteCandidates(scrollPage: ScrollPage, quote: string): IQuoteCandidate[] {
    const candidates: IQuoteCandidate[] = [];

    scrollPage.depthFirstTraverse((node: TreeNode) => {
        if (!node.isContent())
            return;

        let at = node.text.indexOf(quote);
        let guard = 0;
        while (at > -1 && guard++ < MAX_OCCURRENCES) {
            candidates.push({ block: node, index: at });
            at = node.text.indexOf(quote, at + 1);
        }
    });

    return candidates;
}

function pickBestCandidate(
    candidates: IQuoteCandidate[],
    annotation: IAnnotation,
    muya: Muya,
): IQuoteCandidate {
    const { quote, prefix, suffix, ranges, headingPath } = annotation.anchor;
    const ordinals = blockOrdinalMap(muya);
    const originalOrdinal = ordinals.get(pathKey(annotation.anchor.blockPath)) ?? 0;
    let best = candidates[0]!;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
        const { block, index } = candidate;
        let score = 0;
        if (prefix && block.text.slice(Math.max(0, index - prefix.length), index) === prefix)
            score += 2;
        if (suffix && block.text.slice(index + quote.length, index + quote.length + suffix.length) === suffix)
            score += 2;
        if (block.blockName === ranges[0]?.blockName)
            score += 1;
        if (headingPath.length && sameStringArray(headingPathOf(block, muya), headingPath))
            score += 1;

        const distance = Math.abs((ordinals.get(pathKey(block.path)) ?? originalOrdinal) - originalOrdinal);
        score += 1 / (1 + distance);

        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }

    return best;
}

function sameStringArray(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

function trimRange(block: Content, start: number, end: number, score: number): IFuzzyHit {
    const { text } = block;
    let s = Math.max(0, Math.min(start, text.length));
    let e = Math.max(s, Math.min(end, text.length));

    while (s < e && /\s/.test(text[s]!)) {
        s++;
    }
    while (e > s && /\s/.test(text[e - 1]!)) {
        e--;
    }

    return { block, start: s, end: e, score };
}

/** 第 3 段：归一化 + 2-gram Dice 滑窗，取最高分且 ≥ 0.75 的区间。 */
function fuzzyLocate(muya: Muya, quote: string): Nullable<IFuzzyHit> {
    const { scrollPage } = muya.editor;
    if (!scrollPage)
        return null;

    const target = normalizeText(quote);
    if (target.text.length < 4)
        return null;

    const quoteGrams = gramCounts(target.text);
    const quoteGramTotal = target.text.length - 1;
    const sizes = windowSizes(target.text.length);
    let best: Nullable<IFuzzyHit> = null;

    for (const block of contentBlocksOf(scrollPage)) {
        if (!block.text)
            continue;

        const normalized = normalizeText(block.text);
        if (normalized.text.length < 2)
            continue;

        for (const size of sizes) {
            if (normalized.text.length < size)
                continue;

            const hit = bestWindow(quoteGrams, normalized.text, size);
            const score = (2 * hit.inter) / (quoteGramTotal + size - 1);
            if (score < FUZZY_THRESHOLD)
                continue;
            if (best && score <= best.score)
                continue;

            const start = normalized.map[hit.start] ?? 0;
            const end = (normalized.map[hit.start + size - 1] ?? start) + 1;
            best = trimRange(block, start, end, score);
        }
    }

    return best;
}

/** 第 1 段：原地精确（块路径与偏移都还成立，或单段引文在块内被移动）。 */
function relocateInPlace(annotation: IAnnotation, scrollPage: ScrollPage): boolean {
    const { ranges, quote } = annotation.anchor;
    if (!ranges.length)
        return false;

    const blocks = ranges.map(range => resolveContentBlock(scrollPage, range.blockPath));
    if (blocks.some(block => !block))
        return false;

    const current = ranges
        .map((range, index) => blocks[index]!.text.slice(range.start, range.end))
        .join('\n');

    if (current === quote)
        return true;

    if (ranges.length === 1) {
        const index = pickOccurrence(blocks[0]!.text, annotation);
        if (index >= 0) {
            ranges[0]!.start = index;
            ranges[0]!.end = index + quote.length;
            return true;
        }
    }

    return false;
}

function applySingleRange(annotation: IAnnotation, block: Content, start: number, end: number) {
    annotation.anchor.ranges = [rangeOf(block, start, end)];
}

/** 重定位后回写 `currentText`，并按 `sentQuote` 给已复制条目写核对结果。 */
function refreshCurrentText(annotation: IAnnotation, muya: Muya) {
    const { scrollPage } = muya.editor;
    if (!scrollPage) {
        annotation.currentText = undefined;
        return;
    }

    const parts = annotation.anchor.ranges.map((range) => {
        const block = resolveContentBlock(scrollPage, range.blockPath);
        return block ? block.text.slice(range.start, range.end) : null;
    });

    if (parts.includes(null)) {
        annotation.currentText = undefined;
        return;
    }

    const text = parts.join('\n');
    annotation.currentText = text;

    if (annotation.copied && annotation.sentQuote != null)
        annotation.contentChanged = text !== annotation.sentQuote;
}

/**
 * 四段式重定位（命中即停），就地改写 `ranges` / `anchorState` / `currentText` /
 * `contentChanged`。**不改写 `quote` 与各层提示字段**——它们是锚点本体与消歧依据。
 */
export function relocateAnnotation(annotation: IAnnotation, muya: Muya): void {
    const { scrollPage } = muya.editor;
    const { quote } = annotation.anchor;

    if (!scrollPage || !quote) {
        annotation.anchorState = 'orphaned';
        annotation.currentText = undefined;
        annotation.contentChanged = undefined;
        return;
    }

    // 1. 原地精确
    if (relocateInPlace(annotation, scrollPage)) {
        // 「已重定位」是粘性的：位置被自动跟上过一次之后，后续重定位改回 `anchored`
        // 会让面板上那行提示在下一次 debounce 里自己消失（时序相关的假象）。
        if (annotation.anchorState !== 'relocated')
            annotation.anchorState = 'anchored';
        refreshCurrentText(annotation, muya);
        return;
    }

    // 2. 全域精确
    const candidates = collectQuoteCandidates(scrollPage, quote);
    if (candidates.length) {
        const hit
            = candidates.length === 1
                ? candidates[0]!
                : pickBestCandidate(candidates, annotation, muya);
        applySingleRange(annotation, hit.block, hit.index, hit.index + quote.length);
        annotation.anchorState = 'relocated';
        refreshCurrentText(annotation, muya);
        return;
    }

    // 3. 模糊匹配
    const fuzzy = fuzzyLocate(muya, quote);
    if (fuzzy) {
        applySingleRange(annotation, fuzzy.block, fuzzy.start, fuzzy.end);
        annotation.anchorState = 'relocated';
        refreshCurrentText(annotation, muya);
        return;
    }

    // 4. 失效
    annotation.anchorState = 'orphaned';
    annotation.currentText = undefined;
    annotation.contentChanged = undefined;
}

/** 文档顺序（失效条目排最后，同级按块内偏移、再按原顺序稳定排序）。 */
export function orderAnnotationsByDocument(
    annotations: IAnnotation[],
    muya: Muya,
): IAnnotation[] {
    const ordinals = blockOrdinalMap(muya);

    return annotations
        .map((annotation, order) => {
            const first = annotation.anchor.ranges[0];
            const ordinal
                = annotation.anchorState === 'orphaned' || !first
                    ? Number.MAX_SAFE_INTEGER
                    : (ordinals.get(pathKey(first.blockPath)) ?? Number.MAX_SAFE_INTEGER);

            return { annotation, order, ordinal, start: first?.start ?? 0 };
        })
        .sort((a, b) => a.ordinal - b.ordinal || a.start - b.start || a.order - b.order)
        .map(item => item.annotation);
}

/** 在克隆 state 的 `path` 处插入哨兵（路径末段必须是文本字段）。 */
function injectSentinelAtStatePath(
    state: TState[],
    path: TBlockPath,
    offset: number,
    sentinel: string,
): boolean {
    if (!path.length)
        return false;

    let node: unknown = state;
    for (let i = 0; i < path.length - 1; i++) {
        if (node == null || typeof node !== 'object')
            return false;
        node = (node as Record<string | number, unknown>)[path[i]!];
    }

    if (node == null || typeof node !== 'object')
        return false;

    const holder = node as Record<string | number, unknown>;
    const key = path[path.length - 1]!;
    const text = holder[key];
    if (typeof text !== 'string')
        return false;

    const at = Math.max(0, Math.min(offset, text.length));
    holder[key] = text.substring(0, at) + sentinel + text.substring(at);

    return true;
}

/**
 * 批量行号：对当前 state 做**一次克隆**，在每个标注的首段 start、末段 end 处注入
 * 唯一哨兵，序列化一次后读出各哨兵的行号（方案 §5.6 的降级实现——不复用
 * `selection/offsetCursor.ts` 的双哨兵机制，因为那里只支持一个选区，而本轮改动
 * 的文件边界不含该文件）。
 */
export function computeLineNumbers(
    annotations: IAnnotation[],
    muya: Muya,
): Map<string, { start?: number; end?: number }> {
    const result = new Map<string, { start?: number; end?: number }>();
    const { jsonState } = muya.editor;
    const state = jsonState.getState();
    const tag = Math.random().toString(36).slice(2, 8);
    const marks: { id: string; kind: 'start' | 'end'; sentinel: string }[] = [];

    annotations.forEach((annotation, index) => {
        if (annotation.anchorState === 'orphaned')
            return;

        const { ranges } = annotation.anchor;
        const first = ranges[0];
        const last = ranges[ranges.length - 1];
        if (!first || !last)
            return;

        const startSentinel = `${LINE_SENTINEL_PREFIX}${tag}${index}s`;
        const endSentinel = `${LINE_SENTINEL_PREFIX}${tag}${index}e`;
        const sameBlock = samePath(first.blockPath, last.blockPath);
        const startOk = injectSentinelAtStatePath(state, first.blockPath, first.start, startSentinel);
        const endOffset
            = sameBlock && startOk && first.start <= last.end
                ? last.end + startSentinel.length
                : last.end;
        const endOk = injectSentinelAtStatePath(state, last.blockPath, endOffset, endSentinel);

        if (startOk)
            marks.push({ id: annotation.id, kind: 'start', sentinel: startSentinel });
        if (endOk)
            marks.push({ id: annotation.id, kind: 'end', sentinel: endSentinel });
    });

    if (!marks.length)
        return result;

    const markdown = jsonState.getMarkdownFromState(state);
    const located = marks
        .map(mark => ({ mark, index: markdown.indexOf(mark.sentinel) }))
        .filter(item => item.index >= 0)
        .sort((a, b) => a.index - b.index);

    let line = 1;
    let cursor = 0;
    for (const { mark, index } of located) {
        for (let i = cursor; i < index; i++) {
            if (markdown.charCodeAt(i) === 10)
                line++;
        }
        cursor = index;

        // 末段哨兵紧跟换行时（引文正好在行尾结束），它落在下一行行首——回退一行。
        const value = mark.kind === 'end' && index > 0 && markdown[index - 1] === '\n' ? line - 1 : line;
        const entry = result.get(mark.id) ?? {};
        if (mark.kind === 'start')
            entry.start = value;
        else
            entry.end = value;
        result.set(mark.id, entry);
    }

    return result;
}
