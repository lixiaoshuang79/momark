/**
 * 内嵌 HTML 块（编辑器里的 html-block，源文档中就是一段块级原始 HTML）不是正文：
 * 往文档里粘一个网页、一张图表或一段脚本，字数统计就会凭空多出成千上万个字符。
 * 这里把这类行整段剔除，让 word / character / all / paragraph 四项都不再包含它们。
 *
 * 判定沿用 CommonMark 的 HTML 块规则（7 种起始条件）。围栏代码块内的内容原样保留——
 * 代码块里写的 `<div>` 是给人看的代码，不是内嵌 HTML。
 */

/** CommonMark 认可的块级标签名（起始条件 6）。 */
const HTML_BLOCK_TAGS = new Set([
    'address',
    'article',
    'aside',
    'base',
    'basefont',
    'blockquote',
    'body',
    'caption',
    'center',
    'col',
    'colgroup',
    'dd',
    'details',
    'dialog',
    'dir',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'frame',
    'frameset',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'head',
    'header',
    'hr',
    'html',
    'iframe',
    'legend',
    'li',
    'link',
    'main',
    'menu',
    'menuitem',
    'nav',
    'noframes',
    'ol',
    'optgroup',
    'option',
    'p',
    'param',
    'search',
    'section',
    'summary',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'title',
    'tr',
    'track',
    'ul',
]);

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
/** 去掉块引用容器的前导 `>` 标记：`> <div>` 同样是 HTML 块（列表容器未处理，属罕见场景）。 */
const stripContainer = (line: string) => line.replace(/^\s{0,3}(?:>\s?)+/, '');
/** 判定 HTML 块用的归一化行：剥掉容器前缀与 ≤3 个前导空格（CommonMark 的块缩进上限）。 */
const normalize = (line: string) => stripContainer(line).replace(/^\s{0,3}/, '');

/**
 * 本行是否开启一个 HTML 块；是则返回该块的结束判定，不是则返回 null。
 * `previousBlank` 供起始条件 7 使用：完整标签独占一行时，它不能中断段落。
 * 结束判定收到的是原始行，内部自行归一化。
 */
function htmlBlockStart(line: string, previousBlank: boolean): ((l: string) => boolean) | null {
    const s = normalize(line);
    if (!s.startsWith('<'))
        return null;

    // 1. <script / <pre / <style / <textarea：直到出现对应的闭合标签
    const raw = /^<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(s);
    if (raw) {
        const close = new RegExp(`</${raw[1]}>`, 'i');
        return l => close.test(normalize(l));
    }
    // 2~5. 注释、处理指令、声明、CDATA
    if (s.startsWith('<!--'))
        return l => normalize(l).includes('-->');
    if (s.startsWith('<?'))
        return l => normalize(l).includes('?>');
    if (s.startsWith('<![CDATA['))
        return l => normalize(l).includes(']]>');
    if (/^<![a-z]/i.test(s))
        return l => normalize(l).includes('>');
    // 6. 块级标签名开头：到空行结束
    const tag = /^<\/?([a-z][a-z0-9-]*)(?=[\s/>]|$)/i.exec(s);
    if (tag && HTML_BLOCK_TAGS.has(tag[1].toLowerCase()))
        return l => normalize(l).trim() === '';
    // 7. 完整开标签/闭标签独占一行：同样到空行结束，但不能中断段落
    if (previousBlank && /^<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>\s*$/i.test(s)) {
        return l => normalize(l).trim() === '';
    }
    return null;
}

/**
 * 剔掉 markdown 里的块级内嵌 HTML，保留其余内容与段落边界。
 */
export function stripHtmlBlocks(markdown: string): string {
    const kept: string[] = [];
    let fence: string | null = null;
    let end: ((l: string) => boolean) | null = null;

    for (const line of markdown.split('\n')) {
        // HTML 块内部：整段丢弃，按结束条件判断何时收尾
        if (end) {
            if (end(line))
                end = null;
            continue;
        }
        const fenceMatch = FENCE_RE.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            fence = fence === null ? marker : fence === marker ? null : fence;
            kept.push(line);
            continue;
        }
        // 围栏代码块内部原样保留
        if (fence !== null) {
            kept.push(line);
            continue;
        }
        const previousBlank = kept.length === 0 || normalize(kept[kept.length - 1]).trim() === '';
        const start = htmlBlockStart(line, previousBlank);
        if (start) {
            // 用一行空行占位：别把被 HTML 块隔开的前后两段正文粘成一段。
            kept.push('');
            if (!start(line))
                end = start;
            continue;
        }
        kept.push(line);
    }

    return kept.join('\n');
}
