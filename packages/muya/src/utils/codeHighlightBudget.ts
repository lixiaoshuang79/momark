// Prism 语法高亮的输入预算。
//
// Prism 的 JavaScript 语法里，`function` / `function-variable` 两条规则都以
// 「标识符 + 前瞻 `(` / `=`」的形式写成：在一段**连续的标识符字符**上，每个起点都
// 先吞到这段末尾、前瞻失败后再逐字回退，代价是这段长度的平方。正常代码的标识符
// 只有几十个字符，无感；但 base64 载荷（`<script type="text/plain">` 里塞整页源码、
// data: 内联字体/图片）、十六进制串、无空格的长中文行都是**上百万字符的一整段**
// —— 实测 1 万字符 291ms、2 万字符 1.2s、100 万字符按平方外推约 50 分钟，渲染进程
// 主线程就死在这里（墨记 1.6.4 打开 4.4MB PRD 白屏、被系统杀掉的根因）。
//
// HTML 块的源码视图语言是 markup，块里一旦有 `<script>`，脚本正文就按 JavaScript
// 语法嵌套高亮，于是同样的 4MB 载荷「无 script 秒开、有 script 卡死」。

/** 超过这个长度的代码块直接按纯文本显示（与内嵌 HTML 的轻量上限同值）。 */
export const CODE_HIGHLIGHT_MAX_CHARS = 256 * 1024;

/**
 * 最长连续标识符字符段的上限。1000 字符一段的平方回退实测约 3ms；真实代码里的
 * 标识符远短于此，超过的只可能是编码载荷 / 长串数据 / 无标点长文本。
 */
export const CODE_HIGHLIGHT_MAX_TOKEN_RUN = 1000;

// Prism 标识符字符集 `[$\w\xA0-\uFFFF]`（中日韩文字与全角标点也在其中）。
function isIdentifierCode(code: number): boolean {
    return (code >= 48 && code <= 57) // 0-9
        || (code >= 65 && code <= 90) // A-Z
        || (code >= 97 && code <= 122) // a-z
        || code === 95 // _
        || code === 36 // $
        || code >= 0xA0;
}

/**
 * 最长连续标识符字符段的长度。手写线性扫描：`/[\w$]{1000}/` 这种正则在每个
 * 起点都会重扫最多 1000 个字符，4MB 文本上是数十亿步，判定本身就会卡住。
 */
export function longestIdentifierRun(text: string, stopAt = Number.POSITIVE_INFINITY): number {
    let longest = 0;
    let run = 0;

    for (let i = 0; i < text.length; i++) {
        if (isIdentifierCode(text.charCodeAt(i))) {
            run++;
            if (run > longest) {
                longest = run;
                if (longest >= stopAt)
                    return longest;
            }
        }
        else {
            run = 0;
        }
    }

    return longest;
}

/** 这段代码交给 Prism 是否安全（不会落入平方级回退）。 */
export function canHighlightCode(text: string): boolean {
    if (text.length > CODE_HIGHLIGHT_MAX_CHARS)
        return false;

    return longestIdentifierRun(text, CODE_HIGHLIGHT_MAX_TOKEN_RUN) < CODE_HIGHLIGHT_MAX_TOKEN_RUN;
}
