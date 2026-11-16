// 内嵌 HTML 块的「轻 / 重」判定（设计说明见仓库 docs/HTML-轻量内嵌与本地HTML对照评审.md）。
//
// 文档里的 HTML 块只为**轻量 HTML**（图表、小组件、说明性的小片段）做内嵌渲染；
// 整页交互原型这类重量内容不再内嵌，改为降级卡片 + 「在侧栏预览 / 另存为 .html」，
// 评审时以独立 .html 文件与 md 左右对照。
//
// 判定只看源码本身的两个量（都是 O(n) 一次扫描，可在每次渲染时重算）：
//   1. 源码长度 > HTML_LITE_MAX_CHARS
//   2. 单行长度 > HTML_LITE_MAX_LINE（内联 base64 图片/字体/整页源码数据的特征）
// 任一命中即为重量。是否含 `<script>` 不参与判定，只作为提示信息展示。

/** 轻量 HTML 的源码长度上限（字符数）。 */
export const HTML_LITE_MAX_CHARS = 256 * 1024;

/** 轻量 HTML 的单行长度上限（字符数）。 */
export const HTML_LITE_MAX_LINE = 64 * 1024;

export type THtmlHeavyReason = 'size' | 'line';

export interface IHtmlWeight {
    heavy: boolean;
    /** 命中的重量条件（轻量时为空数组） */
    reasons: THtmlHeavyReason[];
    /** 源码字符数 */
    chars: number;
    /** 最长一行的字符数 */
    longestLine: number;
    hasScript: boolean;
}

const SCRIPT_TAG_REG = /<script[\s>/]/i;

export function hasInlineScript(html: string): boolean {
    return SCRIPT_TAG_REG.test(html);
}

export function longestLineLength(text: string): number {
    let longest = 0;
    let start = 0;

    while (start <= text.length) {
        let end = text.indexOf('\n', start);
        if (end === -1)
            end = text.length;
        if (end - start > longest)
            longest = end - start;
        start = end + 1;
    }

    return longest;
}

export function classifyHtmlWeight(html: string): IHtmlWeight {
    const chars = html.length;
    const longestLine = longestLineLength(html);
    const reasons: THtmlHeavyReason[] = [];

    if (chars > HTML_LITE_MAX_CHARS)
        reasons.push('size');

    if (longestLine > HTML_LITE_MAX_LINE)
        reasons.push('line');

    return {
        heavy: reasons.length > 0,
        reasons,
        chars,
        longestLine,
        hasScript: hasInlineScript(html),
    };
}

export function isHeavyHtml(html: string): boolean {
    return html.length > HTML_LITE_MAX_CHARS || longestLineLength(html) > HTML_LITE_MAX_LINE;
}

/** 源码体积的展示文本（UTF-8 字节数，按 KB / MB 取一位小数）。 */
export function formatHtmlSize(html: string): string {
    const bytes = new TextEncoder().encode(html).length;

    if (bytes >= 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;

    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const TITLE_REG = /<title[^>]*>([^<]{1,200})<\/title>/i;

/** 页面标题（只看源码前 64KB，`<title>` 总在 `<head>` 里）。 */
export function extractHtmlTitle(html: string): string {
    const match = TITLE_REG.exec(html.slice(0, 64 * 1024));

    return match ? match[1].trim() : '';
}
