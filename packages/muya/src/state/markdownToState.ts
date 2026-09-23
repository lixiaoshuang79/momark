import type { TBlockToken } from '../utils/marked/types';
import type {
    IAtxHeadingState,
    IBulletListState,
    IHtmlBlockState,
    IHtmlFrameMeta,
    IListItemState,
    IOrderListState,
    ISetextHeadingState,
    ITableState,
    ITaskListItemState,
    ITaskListState,
    TState,
} from './types';
import { firstWordOfInfo } from '../utils';
import { stripFrameMarker } from '../utils/htmlFrameMarker';
import logger from '../utils/logger';
import { lexBlock } from '../utils/marked';

const debug = logger('import markdown: ');

interface IMarkdownToStateOptions {
    footnote: boolean;
    math: boolean;
    isGitlabCompatibilityEnabled: boolean;
    trimUnnecessaryCodeBlockEmptyLines: boolean;
    frontMatter: boolean;
};

const DEFAULT_OPTIONS = {
    footnote: false,
    math: true,
    isGitlabCompatibilityEnabled: true,
    trimUnnecessaryCodeBlockEmptyLines: false,
    frontMatter: true,
};

// Token types whose handler manipulates the `parentList` stack (push a
// container and recurse via synthetic `block-end`), as opposed to the leaf
// tokens that only append a state to the current level.
const CONTAINER_TOKEN_TYPES = new Set([
    'block-end',
    'blockquote',
    'list',
    'list_item',
    'footnote',
]);

export class MarkdownToState {
    /**
     * 上一行是 `<!--momark-frame …-->` 尺寸标记时，标记解析出的 meta 暂存在这里，
     * 等紧随其后的 HTML 块 token 到来再挂上去。markdown 的解析器把注释与它后面的
     * HTML 拆成两个 token（两者都是 HTML 块，但注释以空行语义终结），所以标记要
     * 跨 token 传递。
     */
    private _pendingFrameMeta: IHtmlFrameMeta | null = null;

    constructor(private _options: IMarkdownToStateOptions = DEFAULT_OPTIONS) {}

    generate(markdown: string): TState[] {
        // 每次解析都从干净状态开始：同一个实例可能被复用（多次 generate）。
        this._pendingFrameMeta = null;

        return this._convertMarkdownToState(markdown);
    }

    private _convertMarkdownToState(markdown: string): TState[] {
        const {
            footnote = false,
            math = true,
            isGitlabCompatibilityEnabled = true,
            trimUnnecessaryCodeBlockEmptyLines = false,
            frontMatter = true,
        } = this._options;

        // markdownToState injects synthetic `block-end` markers (see the
        // blockquote/list/list_item/footnote cases below) to pop the parent
        // stack, so the working stream is wider than what `lexBlock` returns.
        const tokens: TBlockToken[] = lexBlock(markdown, {
            footnote,
            math,
            frontMatter,
            isGitlabCompatibilityEnabled,
        });

        const states: TState[] = [];
        let token: TBlockToken | undefined;
        const parentList: TState[][] = [states];

        // eslint-disable-next-line no-cond-assign
        while ((token = tokens.shift())) {
            if (CONTAINER_TOKEN_TYPES.has(token.type))
                this._handleContainerToken(token, parentList, tokens);
            else
                this._handleLeafToken(token, parentList, tokens, trimUnnecessaryCodeBlockEmptyLines);
        }

        return states.length ? states : [{ name: 'paragraph', text: '' }];
    }

    private _handleContainerToken(
        token: TBlockToken,
        parentList: TState[][],
        tokens: TBlockToken[],
    ) {
        let state: TState;
        switch (token.type) {
            // Marks the end of the children's traversal and a return to the previous level
            case 'block-end': {
                // Fix #1735 the blockquote maybe empty. like bellow:
                // >
                // bar
                if (
                    parentList[0].length === 0
                    && (token.tokenType === 'blockquote' || token.tokenType === 'list-item')
                ) {
                    state = {
                        name: 'paragraph' as const,
                        text: '',
                    };
                    parentList[0].push(state);
                }
                parentList.shift();
                break;
            }

            case 'blockquote': {
                state = {
                    name: 'block-quote' as const,
                    children: [],
                };
                parentList[0].push(state);
                parentList.unshift(state.children);
                tokens.unshift({ type: 'block-end', tokenType: 'blockquote' });
                tokens.unshift(...(token.tokens as TBlockToken[]));
                break;
            }

            case 'list': {
                const { listType, loose, start } = token;
                const bulletMarkerOrDelimiter
                    = token.items[0].bulletMarkerOrDelimiter;

                let listState: IOrderListState | IBulletListState | ITaskListState;
                if (listType === 'order') {
                    listState = {
                        name: 'order-list',
                        meta: {
                            loose,
                            start: /^\d+$/.test(String(start)) ? Number(start) : 1,
                            delimiter: bulletMarkerOrDelimiter || '.',
                        },
                        children: [],
                    };
                }
                else if (listType === 'task') {
                    listState = {
                        name: 'task-list',
                        meta: {
                            loose,
                            marker: bulletMarkerOrDelimiter || '-',
                        },
                        children: [],
                    };
                }
                else {
                    listState = {
                        name: 'bullet-list',
                        meta: {
                            loose,
                            marker: bulletMarkerOrDelimiter || '-',
                        },
                        children: [],
                    };
                }

                state = listState;
                parentList[0].push(state);
                parentList.unshift(state.children);
                tokens.unshift({ type: 'block-end', tokenType: 'list' });
                tokens.unshift(...(token.items as TBlockToken[]));
                break;
            }

            case 'list_item': {
                const { listItemType, checked } = token;
                let itemState: IListItemState | ITaskListItemState;
                if (listItemType === 'task') {
                    itemState = {
                        name: 'task-list-item',
                        meta: { checked: Boolean(checked) },
                        children: [],
                    };
                }
                else {
                    itemState = {
                        name: 'list-item',
                        children: [],
                    };
                }

                state = itemState;
                parentList[0].push(state);
                parentList.unshift(state.children);
                tokens.unshift({ type: 'block-end', tokenType: 'list-item' });
                tokens.unshift(...(token.tokens as TBlockToken[]));
                break;
            }

            case 'footnote': {
                // The footnote extension (utils/marked/extensions/footnote.ts)
                // emits a parent token whose `tokens` array holds nested
                // block tokens. Mirror that into a `footnote` container
                // state and recurse via tokens.unshift / block-end.
                const { identifier } = token;
                state = {
                    name: 'footnote' as const,
                    meta: { identifier },
                    children: [],
                };
                parentList[0].push(state);
                parentList.unshift(state.children);
                tokens.unshift({ type: 'block-end', tokenType: 'footnote' });
                tokens.unshift(...(token.tokens as TBlockToken[]));
                break;
            }
        }
    }

    /**
     * `html` token → state。
     *
     * 内嵌 HTML 块的外框尺寸写在块**前面**的一行注释里
     * （`<!--momark-frame w=960 h=436 z=1-->`，见 utils/htmlFrameMarker.ts），而
     * markdown 解析器会把注释与它后面的 HTML 拆成两个 token —— 「整块只有一行标记」
     * 的 token 会单独到达。此时把这个 token 的 meta 暂存下来（返回 undefined，不产出
     * state），交给紧随其后的 HTML 块；标记行本身必须丢掉，绝不能漏进 HTML 预览。
     */
    private _htmlTokenToState(rawText: string): TState | undefined {
        const { text, meta: markerMeta } = stripFrameMarker(rawText);

        if (markerMeta && !text) {
            this._pendingFrameMeta = markerMeta;

            return undefined;
        }

        // TODO: Treat html state which only contains one img as paragraph, we maybe add image state in the future.
        if (/^<img[^<>]+>$/.test(text)) {
            this._pendingFrameMeta = null;

            return { name: 'paragraph' as const, text };
        }

        // 紧跟在标记 token 后面的块取走暂存的 meta；块自己开头带标记（手工编辑）
        // 时以块内标记为准。
        const own = stripFrameMarker(text);
        const state: IHtmlBlockState = {
            name: 'html-block' as const,
            text: own.text,
            meta: this._pendingFrameMeta ?? own.meta ?? {},
        };

        this._pendingFrameMeta = null;

        return state;
    }

    private _handleLeafToken(
        token: TBlockToken,
        parentList: TState[][],
        tokens: TBlockToken[],
        trimUnnecessaryCodeBlockEmptyLines: boolean,
    ) {
        let state: TState;
        let value: string;
        switch (token.type) {
            case 'frontmatter': {
                const { lang, style, text } = token;
                value = text.replace(/^\s+/, '').replace(/\s$/, '');

                state = {
                    name: 'frontmatter' as const,
                    meta: {
                        lang,
                        style,
                    },
                    text: value,
                };

                parentList[0].push(state);
                break;
            }

            case 'hr': {
                state = {
                    name: 'thematic-break' as const,
                    text: token.raw.replace(/\n+$/, ''),
                };

                parentList[0].push(state);
                break;
            }

            case 'heading': {
                const { headingStyle, depth, text, marker } = token;
                value = headingStyle === 'atx'
                    ? `${'#'.repeat(+depth)} ${text}`
                    : text;

                if (headingStyle === 'atx') {
                    const atxState: IAtxHeadingState = {
                        name: 'atx-heading',
                        meta: { level: depth },
                        text: value,
                    };
                    state = atxState;
                }
                else {
                    const setextState: ISetextHeadingState = {
                        name: 'setext-heading',
                        meta: { level: depth, underline: marker },
                        text: value,
                    };
                    state = setextState;
                }

                parentList[0].push(state);
                break;
            }

            case 'code': {
                const { codeBlockStyle, text, lang: infoString = '', raw = '' } = token;
                // marked >=17 appends a trailing newline to indented code text
                // (fenced text has none); strip it so indented blocks round-trip.
                const codeText = codeBlockStyle === 'indented' ? text.replace(/\n$/, '') : text;
                const fenceLength = /^ {0,3}([`~]{3,})/.exec(raw)?.[1].length;
                parentList[0].push(
                    this._buildCodeState(codeText, infoString, codeBlockStyle, trimUnnecessaryCodeBlockEmptyLines, fenceLength),
                );
                break;
            }

            case 'table': {
                const { header, align, rows } = token;
                const tableState: ITableState = {
                    name: 'table',
                    children: [],
                };

                // Store the cell text as marked emits it (with the table `\|`
                // escape already resolved to a literal `|`), so the editor shows
                // `` `|` `` rather than the escaped `` `\|` `` inside inline code
                // (#4849). `escapeText` re-adds the `\|` escape on serialization,
                // keeping the markdown round-trip intact.
                tableState.children.push({
                    name: 'table.row',
                    children: header.map((h, i) => ({
                        name: 'table.cell' as const,
                        meta: { align: align[i] || 'none' },
                        text: h.text,
                    })),
                });

                tableState.children.push(
                    ...rows.map(row => ({
                        name: 'table.row' as const,
                        children: row.map((c, i) => ({
                            name: 'table.cell' as const,
                            meta: { align: align[i] || 'none' },
                            text: c.text,
                        })),
                    })),
                );

                state = tableState;
                parentList[0].push(state);
                break;
            }

            case 'html': {
                const htmlState = this._htmlTokenToState(token.text.trim());

                if (!htmlState)
                    break;

                parentList[0].push(htmlState);
                break;
            }

            case 'multiplemath': {
                const text = token.text.trim();
                const { mathStyle = '' } = token;
                const state = {
                    name: 'math-block' as const,
                    text,
                    meta: { mathStyle },
                };
                parentList[0].push(state);
                break;
            }

            case 'text': {
                value = token.text;
                while (tokens[0]?.type === 'text') {
                    const next = tokens.shift() as Extract<TBlockToken, { type: 'text' }>;
                    value += `\n${next.text}`;
                }
                state = {
                    name: 'paragraph',
                    text: value,
                };
                parentList[0].push(state);
                break;
            }

            case 'paragraph': {
                value = token.text;
                state = {
                    name: 'paragraph' as const,
                    text: value,
                };
                parentList[0].push(state);
                break;
            }

            case 'space': {
                break;
            }

            case 'def': {
                // Marked v16 hoists `[label]: url "title"` reference
                // definitions to block-level `def` tokens. Lower them back
                // to paragraph state nodes so the rest of the pipeline —
                // `InlineRenderer.collectReferenceDefinitions` (regex scan
                // over paragraph text) and round-trip serialization —
                // keeps working without a dedicated state node.
                // Aligns with marktext's "definition is paragraph text"
                // model. See plan section 13 (PR-16).
                state = {
                    name: 'paragraph' as const,
                    text: token.raw.replace(/\n+$/, ''),
                };
                parentList[0].push(state);
                break;
            }

            default:
                debug.warn(`Unknown type ${token.type}`);
                break;
        }
    }

    private _buildCodeState(
        text: string,
        infoString: string,
        codeBlockStyle: 'indented' | undefined,
        trimUnnecessaryCodeBlockEmptyLines: boolean,
        fenceLength?: number,
    ): TState {
        // Keep the whole info string; the language for highlighting / diagram
        // detection is its first word (CommonMark §4.5).
        const info = (infoString || '').trim();
        const lang = firstWordOfInfo(info);

        let value = text;
        // Fix: #1265.
        if (
            trimUnnecessaryCodeBlockEmptyLines
            && (value.endsWith('\n') || value.startsWith('\n'))
        ) {
            value = value.replace(/\n+$/, '').replace(/^\n+/, '');
        }

        const diagramMatch = /^(mermaid|vega-lite|plantuml|flowchart|sequence)$/.exec(lang);
        if (diagramMatch) {
            const diagramType = diagramMatch[1] as 'mermaid' | 'vega-lite' | 'plantuml' | 'flowchart' | 'sequence';
            return {
                name: 'diagram' as const,
                text: value,
                meta: {
                    type: diagramType,
                    lang: diagramType === 'vega-lite' ? 'json' : 'yaml',
                },
            };
        }

        // walkTokens (utils/marked/walkTokens.ts) writes
        // codeBlockStyle = 'fenced' for fenced blocks and
        // leaves 'indented' for indented blocks. marked's
        // type widens the field to `'indented' | undefined`,
        // but `'fenced'` reaches us at runtime via the
        // walkTokens assignment — hence the cast.
        const isFenced = (codeBlockStyle as 'indented' | 'fenced' | undefined) === 'fenced';
        return {
            name: 'code-block' as const,
            meta: {
                type: isFenced ? 'fenced' : 'indented',
                // The full info string verbatim (empty for indented blocks); the
                // language is its first word — see `firstWordOfInfo`.
                lang: info,
                ...(isFenced && fenceLength && fenceLength > 3 ? { fenceLength } : {}),
            },
            text: value,
        };
    }
}
