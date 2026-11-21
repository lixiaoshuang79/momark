import type Content from '../block/base/content';
import type TreeNode from '../block/base/treeNode';
import type { TBlockPath } from '../block/types';
import type { Muya } from '../muya';
import type { TState } from '../state/types';
import type { Nullable } from '../types';
import type {
    IAnnotation,
    IAnnotationRange,
    IAnnotationSnapshot,
    TSnapshotKind,
} from './types';
import { tokenizer, tokensToPlainText } from '../inlineRenderer/lexer';
import { deepClone } from '../utils';
import { diceCoefficient, normalizeText } from './anchor';

/**
 * 标注样式快照（feat/annotation-history-compare）。
 *
 * 「样子」= 一份能重新渲染出该处外观的最小 markdown：
 *   - 块类型（标题级别、列表 / 有序列表 / 任务项、表格行列、引用、代码块语言…）
 *     由 state 链保留下来——不是靠猜 `blockName`；
 *   - 行内格式（加粗、行内代码、链接…）原样留在 markdown 里；
 *   - 标注段在 markdown 里的区间记在 `markStart/markEnd`，渲染时再画高亮。
 *
 * 做法：克隆标注所在的顶层块 state，在标注段两端注入哨兵，**只保留通向标注段
 * 的子树**（列表只留命中项、表格留表头 + 命中行、引用只留命中子块），用引擎
 * 自己的序列化器转成 markdown，再把哨兵摘掉、换算成偏移。和 `computeLineNumbers`
 * 是同一套「克隆 state + 哨兵」手法，不碰 live state。
 */

/**
 * 区间哨兵：CJK 扩展 A 区的生僻字（㐀㐁㐂 / 㐃㐄㐅）。
 *
 * 选字依据是实测 marked 的定界符判定：ASCII 字母紧贴 `**` 时 marked 不认加粗
 * （`ab**粗**` 原样输出）、零宽字符与私用区字符同样会拆坏开合；而中文字符紧贴
 * `**` / `_` 两侧都与正文行为一致（中文文档里 `步**粗**，` 本来就是这样写的）。
 * 渲染侧（snapshotRender.ts）用同一对常量。
 */
export const SNAPSHOT_MARK_START = '\u3400\u3401\u3402';
export const SNAPSHOT_MARK_END = '\u3403\u3404\u3405';

/** 单个叶子文本超过这个长度就按标注段开窗截断（长段落 / 长代码块）。 */
const LEAF_MAX = 1200;
/** 段落开窗：标注段前后各保留的字符数。 */
const LEAF_WINDOW = 360;
/** 代码块开窗：标注段前后各保留的行数。 */
const CODE_WINDOW_LINES = 5;
/** 整份快照 markdown 的上限；超过则退化成只存标注段源码。 */
const SNAPSHOT_MAX = 6000;
/** 段落级兜底匹配（原句被整句改写）：块文本参与比对的最大长度。 */
const BLOCK_COMPARE_MAX = 2000;

const INLINE_MARKERS = new Set(['*', '_', '~']);

interface IStateNode {
    name: string;
    meta?: Record<string, unknown>;
    text?: string;
    children?: IStateNode[];
}

interface IPathInfo {
    trail: string[];
    kind: TSnapshotKind;
    level?: number;
    lang?: string;
    checked?: boolean;
    cell?: { row: number; col: number };
}

interface IPlainOptions {
    superSubScript?: boolean;
    footnote?: boolean;
}

/**
 * state 与本文件的宽松节点视图互转（同一份 JSON，只是本文件按通用树遍历它）。
 * 收口在这两个具名助手里，避免到处双重断言。
 */
function asStateNode(value: unknown): IStateNode {
    return value as IStateNode;
}

function asStates(nodes: unknown): TState[] {
    return nodes as TState[];
}

/** info string 的首词（`ts title="x"` → `ts`）。 */
function firstWord(value: unknown): string {
    return typeof value === 'string' ? (value.trim().split(/\s+/)[0] ?? '') : '';
}

/** state 名链 → 样子归类。 */
export function kindOfTrail(trail: string[]): TSnapshotKind {
    const leaf = trail[trail.length - 1] ?? '';
    switch (leaf) {
        case 'atx-heading':
        case 'setext-heading':
            return 'heading';
        case 'code-block':
            return 'code';
        case 'math-block':
            return 'math';
        case 'html-block':
            return 'html';
        case 'diagram':
            return 'diagram';
        case 'frontmatter':
            return 'frontmatter';
    }

    if (trail.includes('table'))
        return 'table';

    for (let i = trail.length - 2; i >= 0; i--) {
        const name = trail[i];
        if (name === 'task-list')
            return 'task';
        if (name === 'bullet-list' || name === 'order-list')
            return 'list';
        if (name === 'block-quote')
            return 'quote';
        if (name === 'footnote')
            return 'footnote';
    }

    return leaf === 'paragraph' ? 'paragraph' : 'other';
}

/** 沿块路径读 state 链与各层元信息。路径形如 `[3, 'children', 0, 'text']`。 */
function describePath(state: TState[], path: TBlockPath): Nullable<IPathInfo> {
    const top = path[0];
    if (typeof top !== 'number')
        return null;

    let node: IStateNode | undefined = state[top] ? asStateNode(state[top]) : undefined;
    if (!node)
        return null;

    const trail: string[] = [node.name];
    const info: Omit<IPathInfo, 'trail' | 'kind'> = {};
    let tableDepth = -1;
    let rowIndex = -1;

    for (let i = 1; i + 1 < path.length && path[i] === 'children'; i += 2) {
        const index = path[i + 1];
        if (typeof index !== 'number' || !node?.children?.[index])
            break;
        if (node.name === 'table') {
            tableDepth = trail.length;
            rowIndex = index;
        }
        else if (node.name === 'table.row' && tableDepth >= 0) {
            info.cell = { row: rowIndex, col: index };
        }
        node = node.children[index]!;
        trail.push(node.name);
        // 勾选态只属于最近的那层任务列表：任务项里嵌套的普通列表不继承。
        if (node.name === 'task-list-item')
            info.checked = !!node.meta?.checked;
        else if (node.name === 'bullet-list' || node.name === 'order-list')
            delete info.checked;
    }

    if (node.name === 'atx-heading' || node.name === 'setext-heading')
        info.level = Number(node.meta?.level) || 1;
    if (node.name === 'code-block')
        info.lang = firstWord(node.meta?.lang);

    return { trail, kind: kindOfTrail(trail), ...info };
}

/** 标注段 → 渲染后的纯文本（逐行走行内 lexer；标题去掉前导井号）。 */
export function plainOfQuote(text: string, kind: TSnapshotKind, options: IPlainOptions = {}): string {
    const superSubScript = options.superSubScript ?? true;
    const footnote = options.footnote ?? false;

    return text
        .split('\n')
        .map((line, index) => {
            const source = kind === 'heading' && index === 0 ? line.replace(/^\s{0,3}#{1,6}\s+/, '') : line;
            if (kind === 'code' || kind === 'math' || kind === 'html' || kind === 'diagram' || kind === 'frontmatter')
                return source;

            return tokensToPlainText(
                tokenizer(source, { hasBeginRules: false, options: { superSubScript, footnote } }),
            );
        })
        .join('\n');
}

/**
 * 哨兵落点避开定界符内部：偏移若正好切在一串 `**` / `__` / `~~` 中间，
 * 起点挪到这串的开头、终点挪到这串的末尾（否则 `*哨兵*` 会把加粗拆坏）。
 */
function snapOffset(text: string, offset: number, side: 'start' | 'end'): number {
    let at = Math.max(0, Math.min(offset, text.length));
    const inside = (i: number) =>
        i > 0 && i < text.length && INLINE_MARKERS.has(text[i - 1]!) && text[i - 1] === text[i];

    if (side === 'start') {
        while (inside(at))
            at--;
    }
    else {
        while (inside(at))
            at++;
    }

    return at;
}

/** 在克隆子树里按相对路径插入哨兵（路径末段必须是文本字段）。 */
function injectAt(root: IStateNode, rel: TBlockPath, offset: number, sentinel: string): boolean {
    let holder: unknown = root;
    for (let i = 0; i < rel.length - 1; i++) {
        if (holder == null || typeof holder !== 'object')
            return false;
        holder = (holder as Record<string | number, unknown>)[rel[i]!];
    }
    if (holder == null || typeof holder !== 'object')
        return false;

    const record = holder as Record<string | number, unknown>;
    const key = rel[rel.length - 1]!;
    const text = record[key];
    if (typeof text !== 'string')
        return false;

    const at = Math.max(0, Math.min(offset, text.length));
    record[key] = text.substring(0, at) + sentinel + text.substring(at);

    return true;
}

/** 超长叶子按哨兵开窗（段落按字符、代码按行），没有哨兵的超长叶子直接截头。 */
function windowLeaf(text: string, code: boolean): string {
    if (text.length <= LEAF_MAX)
        return text;

    const startAt = text.indexOf(SNAPSHOT_MARK_START);
    const endAt = text.indexOf(SNAPSHOT_MARK_END);
    const from = startAt >= 0 ? startAt : endAt >= 0 ? endAt : 0;
    const to = endAt >= 0 ? endAt + SNAPSHOT_MARK_END.length : startAt >= 0 ? startAt + SNAPSHOT_MARK_START.length : LEAF_MAX;

    if (code) {
        const lines = text.split('\n');
        let cursor = 0;
        let fromLine = 0;
        let toLine = lines.length - 1;
        lines.forEach((line, index) => {
            const lineEnd = cursor + line.length;
            if (from >= cursor && from <= lineEnd)
                fromLine = index;
            if (to >= cursor && to <= lineEnd)
                toLine = index;
            cursor = lineEnd + 1;
        });
        const a = Math.max(0, fromLine - CODE_WINDOW_LINES);
        const b = Math.min(lines.length, toLine + CODE_WINDOW_LINES + 1);
        const kept = lines.slice(a, b);
        if (a > 0)
            kept.unshift('…');
        if (b < lines.length)
            kept.push('…');
        return kept.join('\n');
    }

    const a = Math.max(0, from - LEAF_WINDOW);
    const b = Math.min(text.length, to + LEAF_WINDOW);

    return `${a > 0 ? '…' : ''}${text.slice(a, b)}${b < text.length ? '…' : ''}`;
}

/** 对子树里所有文本叶子开窗（表格行、跨块中间段都可能很长）。 */
function windowTree(node: IStateNode): void {
    if (typeof node.text === 'string') {
        const code = node.name === 'code-block' || node.name === 'html-block' || node.name === 'diagram';
        node.text = windowLeaf(node.text, code);
    }
    node.children?.forEach(windowTree);
}

/**
 * 只保留通向标注段的子树。`rels` 是相对本节点的路径（`['children', 1, …]`）。
 * - 表格：始终保留表头（第 0 行），表格行内的单元格全部保留（行是最小语境）；
 * - 有序列表：起始序号跟着第一个保留项走，渲染出的编号与原文一致；
 * - 其余容器：只留命中的子块。
 */
function pruneTree(node: IStateNode, rels: TBlockPath[]): IStateNode {
    if (!Array.isArray(node.children) || node.name === 'table.row')
        return node;

    const kept = new Set<number>();
    for (const rel of rels) {
        if (rel[0] === 'children' && typeof rel[1] === 'number')
            kept.add(rel[1]);
    }
    if (!kept.size)
        return node;
    if (node.name === 'table')
        kept.add(0);
    // 列表项：命中的是嵌套子列表时，把该项自己的首段也留下——否则父项的
    // 勾选框 / 序号会「挪」到子项上，样子就不对了。
    if (node.name === 'list-item' || node.name === 'task-list-item')
        kept.add(0);

    const order = [...kept].filter(index => !!node.children![index]).sort((a, b) => a - b);
    const next: IStateNode = {
        ...node,
        children: order.map(index =>
            pruneTree(
                node.children![index]!,
                rels
                    .filter(rel => rel[0] === 'children' && rel[1] === index)
                    .map(rel => rel.slice(2)),
            ),
        ),
    };

    if (node.name === 'order-list' && order.length) {
        const start = Number(node.meta?.start);
        next.meta = { ...node.meta, start: (Number.isFinite(start) ? start : 1) + order[0]! };
    }

    return next;
}

/** 从 markdown 里摘掉哨兵并给出区间（任一端缺失 → -1）。 */
function extractMarks(markdown: string): { markdown: string; markStart: number; markEnd: number } {
    let text = markdown;
    const startAt = text.indexOf(SNAPSHOT_MARK_START);
    if (startAt >= 0)
        text = text.slice(0, startAt) + text.slice(startAt + SNAPSHOT_MARK_START.length);
    const endAt = text.indexOf(SNAPSHOT_MARK_END);
    if (endAt >= 0)
        text = text.slice(0, endAt) + text.slice(endAt + SNAPSHOT_MARK_END.length);

    // 理论上只有一对；万一序列化器复制了文本（不会发生），也不让哨兵漏进快照。
    text = text.split(SNAPSHOT_MARK_START).join('').split(SNAPSHOT_MARK_END).join('');

    if (startAt >= 0 && endAt >= startAt)
        return { markdown: text, markStart: startAt, markEnd: endAt };

    return { markdown: text, markStart: -1, markEnd: -1 };
}

function resolveContent(muya: Muya, path: TBlockPath): Nullable<Content> {
    const { scrollPage } = muya.editor;
    if (!scrollPage)
        return null;
    // `queryBlock` 会就地 shift 传入的路径数组，必须给副本。
    const block = scrollPage.queryBlock([...path]);

    return block && block.isContent() ? block : null;
}

export interface ICaptureOptions {
    /** false = 只渲染块、不画标注段（段落级兜底匹配用）。 */
    mark?: boolean;
    capturedAt?: number;
}

/**
 * 按定位段拍一张样式快照。块解析不到 / 路径不在 state 里时返回 null。
 */
export function captureSnapshot(
    ranges: IAnnotationRange[],
    muya: Muya,
    options: ICaptureOptions = {},
): Nullable<IAnnotationSnapshot> {
    const { jsonState } = muya.editor;
    if (!ranges.length || !jsonState)
        return null;

    const blocks = ranges.map(range => resolveContent(muya, range.blockPath));
    if (blocks.some(block => !block))
        return null;

    const state = jsonState.getStateRef();
    const first = ranges[0]!;
    const last = ranges[ranges.length - 1]!;
    const info = describePath(state, first.blockPath);
    if (!info)
        return null;

    const text = ranges.map((range, index) => blocks[index]!.text.slice(range.start, range.end)).join('\n');
    const tops = [...new Set(ranges.map(range => range.blockPath[0]))]
        .filter((top): top is number => typeof top === 'number' && !!state[top])
        .sort((a, b) => a - b);
    if (!tops.length)
        return null;

    const clones = new Map<number, IStateNode>(
        tops.map(top => [top, asStateNode(deepClone(state[top]))]),
    );

    // 代码块的「语言」输入框与代码正文共用 `[i, 'text']` 这条路径（见 content.ts
    // 的 text setter），往里注哨兵会落进代码正文的错误位置；公式渲染后哨兵会进
    // KaTeX 输出——这几类只渲染、不画区间。
    const canMark
        = options.mark !== false
            && info.kind !== 'math'
            && !ranges.some(range => range.blockName === 'language-input');

    if (canMark) {
        const firstText = blocks[0]!.text;
        const lastText = blocks[blocks.length - 1]!.text;
        // 标题块的文本自带 `## ` 前缀：哨兵落进井号里会把标题拆坏，夹到前缀之后。
        const headingPrefix = (text: string, name: string) =>
            /heading/.test(name) ? (/^\s{0,3}#{1,6}\s+/.exec(text)?.[0].length ?? 0) : 0;
        const start = snapOffset(firstText, Math.max(first.start, headingPrefix(firstText, first.blockName)), 'start');
        const end = snapOffset(lastText, Math.max(last.end, headingPrefix(lastText, last.blockName)), 'end');
        const firstRoot = clones.get(first.blockPath[0] as number)!;
        const lastRoot = clones.get(last.blockPath[0] as number)!;
        // 同一叶子时先插终点，起点的偏移不受影响。
        injectAt(lastRoot, last.blockPath.slice(1), end, SNAPSHOT_MARK_END);
        injectAt(firstRoot, first.blockPath.slice(1), start, SNAPSHOT_MARK_START);
    }

    const pruned = tops.map((top) => {
        const root = pruneTree(
            clones.get(top)!,
            ranges.filter(range => range.blockPath[0] === top).map(range => range.blockPath.slice(1)),
        );
        windowTree(root);
        return root;
    });

    let serialized = '';
    try {
        serialized = jsonState.getMarkdownFromState(asStates(pruned));
    }
    catch {
        serialized = '';
    }

    let { markdown, markStart, markEnd } = extractMarks(serialized.replace(/\n+$/, ''));

    if (!markdown || markdown.length > SNAPSHOT_MAX) {
        // 退化：只存标注段源码（仍可渲染出行内格式，只是没有块语境）。
        markdown = text;
        markStart = canMark ? 0 : -1;
        markEnd = canMark ? text.length : -1;
    }

    const { superSubScript, footnote } = muya.options;

    return {
        kind: info.kind,
        trail: info.trail,
        ...(info.level != null ? { level: info.level } : {}),
        ...(info.lang ? { lang: info.lang } : {}),
        ...(info.checked != null ? { checked: info.checked } : {}),
        ...(info.cell ? { cell: info.cell } : {}),
        markdown,
        markStart,
        markEnd,
        text,
        plain: plainOfQuote(text, info.kind, { superSubScript, footnote }),
        capturedAt: options.capturedAt ?? Date.now(),
    };
}

/** 引文在块文本里的位置：优先 prefix+quote 精确命中，其次 quote 首次出现。 */
function locateQuote(blockText: string, quote: string, prefix: string): number {
    if (prefix) {
        const at = blockText.indexOf(prefix + quote);
        if (at >= 0)
            return at + prefix.length;
    }

    return blockText.indexOf(quote);
}

/**
 * 旧版（v2）条目没有快照：用锚点里留下的 `blockText` / `blockName` / `quote`
 * 尽力反推一张近似快照（`legacy: true`）。能还原的只有：标题（块文本自带井号）、
 * 表格单元格（套一个单格表）、代码块（套围栏）、普通段落的行内格式；列表、引用
 * 等容器信息 v2 根本没存，按段落处理。纯函数，不需要引擎实例。
 */
export function legacySnapshot(annotation: IAnnotation): Nullable<IAnnotationSnapshot> {
    const { quote, blockText, blockTextTail, prefix, ranges } = annotation.anchor ?? ({} as IAnnotation['anchor']);
    if (!quote || annotation.global)
        return null;

    const blockName = ranges?.[0]?.blockName ?? '';
    let kind: TSnapshotKind = 'paragraph';
    let trail = ['paragraph'];
    let level: number | undefined;
    let head = '';
    let tail = '';

    if (/heading/.test(blockName)) {
        kind = 'heading';
        trail = ['atx-heading'];
        level = Math.min(6, Math.max(1, (/^\s{0,3}(#{1,6})\s/.exec(blockText ?? '')?.[1]?.length) ?? 1));
    }
    else if (/table/.test(blockName)) {
        kind = 'table';
        trail = ['table', 'table.row', 'table.cell'];
        head = '| ';
        tail = ' |\n| --- |';
    }
    else if (/code/.test(blockName)) {
        kind = 'code';
        trail = ['code-block'];
        head = '```\n';
        tail = '\n```';
    }
    else if (blockName && !/paragraph/.test(blockName)) {
        kind = 'other';
        trail = [];
    }

    const lines = quote.split('\n');
    const base = blockText ?? '';
    let markdown = `${head}${base}${tail}`;
    let markStart = -1;
    let markEnd = -1;

    if (lines.length > 1 && blockTextTail) {
        const firstAt = locateQuote(base, lines[0]!, prefix ?? '');
        const lastLine = lines[lines.length - 1]!;
        const tailAt = blockTextTail.lastIndexOf(lastLine);
        markdown = `${head}${base}${tail}\n\n${blockTextTail}`;
        if (firstAt >= 0 && tailAt >= 0) {
            markStart = head.length + firstAt;
            markEnd = head.length + base.length + tail.length + 2 + tailAt + lastLine.length;
        }
    }
    else {
        const at = locateQuote(base, quote, prefix ?? '');
        if (at >= 0) {
            markStart = head.length + at;
            markEnd = markStart + quote.length;
        }
    }

    if (!base) {
        markdown = quote;
        markStart = 0;
        markEnd = quote.length;
    }

    return {
        kind,
        trail,
        ...(level != null ? { level } : {}),
        markdown,
        markStart,
        markEnd,
        text: quote,
        plain: plainOfQuote(quote, kind),
        capturedAt: annotation.createdAt,
        legacy: true,
    };
}

/** 该条标注「标注时」的快照：有真快照用真快照，否则按 v2 字段反推。 */
export function originSnapshotOf(annotation: IAnnotation): Nullable<IAnnotationSnapshot> {
    return annotation.origin ?? legacySnapshot(annotation);
}

function contentBlocksOf(muya: Muya): Content[] {
    const blocks: Content[] = [];
    muya.editor.scrollPage?.depthFirstTraverse((node: TreeNode) => {
        if (node.isContent() && node.blockName !== 'language-input')
            blocks.push(node);
    });
    return blocks;
}

function sameStart(text: string, expected: string): boolean {
    return !!expected && text.slice(0, expected.length) === expected;
}

/**
 * 段落级兜底：引文已找不到（被整句改写，2-gram 相似度跌破 0.75），但原来那个
 * 段落多半还在原处。按「前后邻接块还对得上」+「块文本整体相似度」找它：
 *   - 前后邻居都对得上 → 就是它（原地被改写）；
 *   - 一侧邻居对得上且整体相似度 ≥ 0.35；
 *   - 或者整体相似度 ≥ 0.6。
 * 找不到返回 null（= 真删了）。只用于历史里展示「现在」，不改锚点状态。
 */
export function findReplacementBlock(annotation: IAnnotation, muya: Muya): Nullable<Content> {
    const { blockText, beforeBlockText, afterBlockText, ranges } = annotation.anchor;
    const original = normalizeText((blockText ?? '').slice(0, BLOCK_COMPARE_MAX)).text;
    const blockName = ranges[0]?.blockName;
    let best: Nullable<{ block: Content; score: number }> = null;

    for (const block of contentBlocksOf(muya)) {
        const previous = block.previousContentInContext();
        const next = block.nextContentInContext();
        // 原来就在文档开头 / 末尾（邻接文本为空）时，「现在也在开头 / 末尾」同样算对上。
        const before = beforeBlockText ? !!previous && sameStart(previous.text, beforeBlockText) : !previous;
        const after = afterBlockText ? !!next && sameStart(next.text, afterBlockText) : !next;
        const dice = original
            ? diceCoefficient(original, normalizeText(block.text.slice(0, BLOCK_COMPARE_MAX)).text)
            : 0;

        const accepted = (before && after) || ((before || after) && dice >= 0.35) || dice >= 0.6;
        if (!accepted)
            continue;

        const score = dice + (before ? 0.5 : 0) + (after ? 0.5 : 0) + (block.blockName === blockName ? 0.1 : 0);
        if (!best || score > best.score)
            best = { block, score };
    }

    return best?.block ?? null;
}
