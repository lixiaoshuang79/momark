/**
 * 内嵌 HTML 块「外框尺寸」在 markdown 里的落盘格式。
 *
 * 需求：用户拖拽 / 缩放过 HTML 块之后，尺寸要跟着文档走 —— 关掉再打开还是他调好的
 * 那个大小，而不是每次重新拖。
 *
 * 为什么用一行 HTML 注释承载：
 * - 尺寸属于块的**元信息**，不是块的正文。写进正文会污染作者的 HTML（改一次尺寸就
 *   改一次源码，diff 里全是噪音）；而 HTML 注释本来就是「看不见的内容」，渲染层不
 *   显示它，导出、字数统计也都按 HTML 块整段跳过。
 * - 它是 CommonMark 的「类型 2」HTML 块（`<!--` 起、`-->` 止），因此
 *   `utils/htmlBlock.ts` 会把这一行继续识别成 HTML 块的一部分，不会漏成正文。
 *
 * 注释写不写在块文本里：
 * - 解析阶段（markdownToState）会把这一行从块文本里**摘掉**并解析进 `state.meta`，
 *   所以渲染内容与没有注释时逐字节一致；
 * - 序列化阶段（stateToMarkdown）再从 `state.meta` 把它写回块的**前面**。
 *
 * 格式：`<!--momark-frame w=960 h=436 z=1-->`，只写有值的键：
 * - `w` / `h`：外框视口宽高，整数像素（`Math.round`）；
 * - `z`：缩放比例，最多保留两位小数（1.25 = 125%）。
 */
import type { IHtmlFrameMeta } from '../state/types';

/** 标记前缀。带 `momark-frame` 关键字，避免把用户自己的普通注释误判成尺寸标记。 */
const MARKER_PREFIX = '<!--momark-frame';
/** 完整标记：`<!--` + `momark-frame` + 任意键值 + `-->`。只认单行、整行。 */
const MARKER_RE = /^<!--momark-frame(?<body>[^>]*)-->\s*$/;

/** 把浮点数收敛成「最多两位小数」的字面量：1.25 → `1.25`，1 → `1`，0.3333 → `0.33`。 */
function trimNumber(value: number): string {
    return String(Math.round(value * 100) / 100);
}

/**
 * 由 meta 构造注释行（不含换行）。返回值一定是完整一行，调用方负责加换行与缩进。
 * 没有任何有效数字时返回 `''`：宁可整行不写，也不写出一个空壳标记。
 */
export function buildFrameMarker(meta: IHtmlFrameMeta | undefined): string {
    if (!meta)
        return '';

    const parts: string[] = [];

    if (typeof meta.width === 'number' && Number.isFinite(meta.width))
        parts.push(`w=${Math.round(meta.width)}`);

    if (typeof meta.height === 'number' && Number.isFinite(meta.height))
        parts.push(`h=${Math.round(meta.height)}`);

    // 缩放为 1 是「没缩放过」的等价物，但用户可能明确按过 ±，保留它以区分
    // 「曾经调过尺寸」与「从未动过」——首次打开的块不该被当成用户调过的块。
    if (typeof meta.zoom === 'number' && Number.isFinite(meta.zoom))
        parts.push(`z=${trimNumber(meta.zoom)}`);

    return parts.length ? `${MARKER_PREFIX} ${parts.join(' ')}-->` : '';
}

/**
 * 从块文本里摘掉开头的尺寸标记行，返回剩下的文本与解析出的 meta。
 * 没有标记时原样返回（只有 `text`），老文档零影响。
 *
 * 只认**第一行**：标记是块的前缀，正文里偶现的普通注释不参与解析。
 */
export function stripFrameMarker(text: string): { text: string; meta?: IHtmlFrameMeta } {
    const newlineAt = text.indexOf('\n');
    const firstLine = (newlineAt === -1 ? text : text.slice(0, newlineAt)).trim();
    const match = MARKER_RE.exec(firstLine);

    if (!match)
        return { text };

    const rest = newlineAt === -1 ? '' : text.slice(newlineAt + 1);
    const meta: IHtmlFrameMeta = {};
    // 键值对用空格分隔；无法识别的键直接忽略（向前兼容：以后加键，老版本读不炸）。
    for (const pair of (match.groups?.body ?? '').trim().split(/\s+/)) {
        const [key, raw] = pair.split('=');

        if (key === 'w') {
            const width = Number.parseInt(raw ?? '', 10);

            if (Number.isFinite(width))
                meta.width = width;
        }
        else if (key === 'h') {
            const height = Number.parseInt(raw ?? '', 10);

            if (Number.isFinite(height))
                meta.height = height;
        }
        else if (key === 'z') {
            const zoom = Number(raw);

            if (Number.isFinite(zoom))
                meta.zoom = zoom;
        }
    }

    // 整块只有这一行标记（块被删空、只剩标记）时剩空文本 —— 与「空 HTML 块」的
    // 表现一致（渲染成 `<Empty HTML Block>` 占位）。没有解析出任何数值时也照样
    // 摘掉标记行：标记本身不该漏进渲染内容，只是不产出 meta。
    return Object.keys(meta).length ? { text: rest, meta } : { text: rest };
}
