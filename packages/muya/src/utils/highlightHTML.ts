import type { IHighlight } from '../inlineRenderer/types';
import { ANNOTATION_CLASS_NAMES } from '../annotation/types';
import { CLASS_NAMES } from '../config';
import { getLongUniqueId } from '../utils';

// TODO: @jocs any better solutions?
export const MARKER_HASH = {
    '<': `%${getLongUniqueId()}%`,
    '>': `%${getLongUniqueId()}%`,
    '"': `%${getLongUniqueId()}%`,
    '\'': `%${getLongUniqueId()}%`,
};

/** 高亮 class：标注按 `type`，缺省（搜索）按 `active`。与 `Renderer.getHighlightClassName` 同口径。 */
function highlightClassName({ type = 'search', active }: IHighlight) {
    if (type === 'annotation')
        return ANNOTATION_CLASS_NAMES.MU_ANNOTATION;
    if (type === 'annotation-active')
        return ANNOTATION_CLASS_NAMES.MU_ANNOTATION_ACTIVE;

    return active ? CLASS_NAMES.MU_HIGHLIGHT : CLASS_NAMES.MU_SELECTION;
}

/** 开标签：标注带 `data-index` 时补上序号属性（角标由 CSS 伪元素消费）。 */
function openTag(className: string, dataIndex: number | undefined, escape: boolean) {
    if (escape) {
        const index
            = dataIndex == null
                ? ''
                : ` data-index=${MARKER_HASH['"']}${dataIndex}${MARKER_HASH['"']}`;

        return `${MARKER_HASH['<']}span class=${MARKER_HASH['"']}${className}${MARKER_HASH['"']}${index}${MARKER_HASH['>']}`;
    }

    const index = dataIndex == null ? '' : ` data-index="${dataIndex}"`;

    return `<span class="${className}"${index}>`;
}

export function getHighlightHtml(text: string, highlights: IHighlight[], escape = false, handleLineEnding = false) {
    let code = '';
    let pos = 0;

    const getEscapeHTML = (className: string, content: string, dataIndex?: number) => {
        return `${openTag(className, dataIndex, true)}${content}${MARKER_HASH['<']}/span${MARKER_HASH['>']}`;
    };

    for (const highlight of highlights) {
        const { start, end } = highlight;
        code += text.substring(pos, start);
        const className = highlightClassName(highlight);
        const dataIndex = highlight.data?.index;
        let highlightContent = text.substring(start, end);
        if (handleLineEnding && text.endsWith('\n') && end === text.length) {
            highlightContent
                = highlightContent.substring(start, end - 1)
                    + (escape
                        ? getEscapeHTML(CLASS_NAMES.MU_LINE_END, '\n')
                        : `<span class="${CLASS_NAMES.MU_LINE_END}">\n</span>`);
        }
        code += escape
            ? getEscapeHTML(className, highlightContent, dataIndex)
            : `${openTag(className, dataIndex, false)}${highlightContent}</span>`;
        pos = end;
    }

    if (pos !== text.length) {
        if (handleLineEnding && text.endsWith('\n')) {
            code
                += text.substring(pos, text.length - 1)
                    + (escape
                        ? getEscapeHTML(CLASS_NAMES.MU_LINE_END, '\n')
                        : `<span class="${CLASS_NAMES.MU_LINE_END}">\n</span>`);
        }
        else {
            code += text.substring(pos);
        }
    }

    return code;
}
