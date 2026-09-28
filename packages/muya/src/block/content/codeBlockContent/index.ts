import type { IHighlight } from '../../../inlineRenderer/types';
import type { Muya } from '../../../muya';
import type { IRenderCursor } from '../../../selection/types';
import type {
    CodeContentState,
    ICodeBlockState,
    IDiagramState,
    IFrontmatterState,
} from '../../../state/types';
import type Code from '../../commonMark/codeBlock/code';
import type HTMLPreview from '../../commonMark/html/htmlPreview';
import { HTML_TAGS, VOID_HTML_TAGS } from '../../../config';
import { adjustOffset, escapeHTML, firstWordOfInfo } from '../../../utils';
import { computeLineCount, repositionLineNumberSpans, syncLineNumbersSpans } from '../../../utils/codeBlockLineNumbers';
import { getHighlightHtml, MARKER_HASH } from '../../../utils/highlightHTML';
import prism, { loadedLanguages, transformAliasToOrigin, walkTokens } from '../../../utils/prism/index';
import Content from '../../base/content';
import { ScrollPage } from '../../scrollPage';

function checkAutoIndent(text: string, offset: number) {
    const pairStr = text.substring(offset - 1, offset + 1);

    return /^(?:\{\}|\[\]|\(\)|><)$/.test(pairStr);
}

function getIndentSpace(text: string, offset: number) {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1)
        lineEnd = text.length;
    const match = /^(\s*)\S/.exec(text.slice(lineStart, lineEnd));

    return match ? match[1] : '';
}

/**
 * parseSelector
 * div#id.className => {tag: 'div', id: 'id', className: 'className', isVoid: false}
 */

function parseSelector(str = '') {
    const REG_EXP = /(#|\.)([^#.]+)/;
    let tag = '';
    let id = '';
    let className = '';
    let isVoid = false;
    let cap;

    for (const tagName of HTML_TAGS) {
        if (
            str.startsWith(tagName)
            && (!str[tagName.length] || /#|\./.test(str[tagName.length]))
        ) {
            tag = tagName;
            if ((VOID_HTML_TAGS as readonly string[]).includes(tagName))
                isVoid = true;

            str = str.substring(tagName.length);
        }
    }

    if (tag !== '') {
        cap = REG_EXP.exec(str);
        while (cap && str.length) {
            if (cap[1] === '#')
                id = cap[2];
            else
                className = cap[2];

            str = str.substring(cap[0].length);
            cap = REG_EXP.exec(str);
        }
    }

    return { tag, id, className, isVoid };
}

const LANG_HASH = {
    'html-block': 'html',
    'math-block': 'latex',
};

// Restore the placeholder markers `getHighlightHtml(.., escape=true)` writes
// around the syntax tags it emits. `MARKER_HASH` is a module-level constant, so
// the four patterns derived from it are constant too — building them inside
// `update()` allocated four `RegExp` objects on every keystroke for nothing.
// (`String.prototype.replace` with a /g regex always starts at index 0 and
// resets `lastIndex` afterwards, so sharing them across calls is safe.)
const MARKER_RESTORE = [
    [new RegExp(MARKER_HASH['<'], 'g'), '<'],
    [new RegExp(MARKER_HASH['>'], 'g'), '>'],
    [new RegExp(MARKER_HASH['"'], 'g'), '"'],
    [new RegExp(MARKER_HASH['\''], 'g'), '\''],
] as const;

// Identity of a highlight list for the render memo: every field
// `getHighlightHtml` reads off a highlight (`index` is the only one that reaches
// the markup today) plus `copied`, whose change is meant to repaint. Compared by
// string equality, so a new list with equal content is a cache hit.
function highlightSignature(highlights: IHighlight[]) {
    let signature = '';
    for (const { start, end, active, type, data } of highlights)
        signature += `${start}:${end}:${active ? 1 : 0}:${type ?? ''}:${data?.index ?? ''}:${data?.copied ? 1 : 0};`;

    return signature;
}

function hasStateMeta(
    state: CodeContentState,
): state is ICodeBlockState | IDiagramState | IFrontmatterState {
    return /code-block|diagram|frontmatter/.test(state.name);
}

class CodeBlockContent extends Content {
    private _initialLang: string;
    public override parent: Code | null = null;

    static override blockName = 'codeblock.content';

    static create(muya: Muya, state: CodeContentState) {
        const content = new CodeBlockContent(muya, state);

        return content;
    }

    // The language word for highlighting / tokenizing — the first word of the
    // code container's info string (which may carry attributes, e.g.
    // `js title="x"`). Every consumer of `_lang` wants the language, never the
    // full info string (that is read from `meta.lang` directly by the language
    // input), so derive it once here.
    private get _lang() {
        const { _codeContainer: codeContainer } = this;

        return firstWordOfInfo(codeContainer ? codeContainer.lang : this._initialLang);
    }

    /**
     * Always be the `pre` element
     */
    private get _codeContainer() {
        return this.parent?.parent;
    }

    get outContainer() {
        const { _codeContainer: codeContainer } = this;

        return /code-block|frontmatter/.test(codeContainer!.blockName)
            ? codeContainer
            : codeContainer!.parent;
    }

    // The text the preview was last rendered from. Seeded with the initial
    // text so the create-pass update() does not re-trigger a render that races
    // the preview's own one-shot render on append (async for diagrams).
    private _lastPreviewText: string;

    constructor(muya: Muya, state: CodeContentState) {
        super(muya, state.text);
        this._lastPreviewText = state.text;
        if (hasStateMeta(state))
            this._initialLang = state.meta.lang;
        else
            this._initialLang = LANG_HASH[state.name];

        this.classList = [...this.classList, 'mu-codeblock-content'];
        // Used for empty status prompts
        this.attributes.frontMatter = muya.i18n.t('Input Front Matter...');
        this.attributes.math = muya.i18n.t('Input Mathematical Formula...');
        this.createDomNode();
    }

    override getAnchor() {
        return this.outContainer;
    }

    // Some block has a preview container, like math, diagram, html, should update the preview if the text changed.
    private _updatePreviewIfHave(text: string) {
        // update() runs during the initial create pass before this block is
        // attached, when outContainer cannot resolve its parent chain.
        if (!this._codeContainer)
            return;
        // Only re-render when the text actually changed. update() is called on
        // every render pass; without this guard a diagram's create-pass render
        // and update()'s render race (DiagramPreview.update is async), leaving
        // the SVG unmounted.
        if (text === this._lastPreviewText)
            return;
        this._lastPreviewText = text;
        if (this.outContainer?.attachments?.length)
            (this.outContainer?.attachments?.head as HTMLPreview).update(text);
    }

    // Payload of the last highlight render. `update()` re-tokenizes the WHOLE
    // block with Prism (or rewrites the raw HTML) and replaces the block's
    // innerHTML, and it is called far more often than the payload changes: the
    // constructor's create pass, the gutter-seeding rAF and the language-load
    // callback all render the same text in a row, and search / annotation /
    // repaint passes re-render blocks whose text never moved. Skipping the
    // render when text + resolved language + highlight set are unchanged drops
    // those duplicates without touching the keystroke path — there the text
    // always differs, so a real re-highlight still happens (making THAT cheap
    // needs a frame-coalesced render, which cannot be done without also
    // deferring the caret restore that must follow the innerHTML swap).
    private _renderedText: string | null = null;
    private _renderedLang: string | null = null;
    private _renderedHighlights = '';

    override update(_cursor?: IRenderCursor, highlights: IHighlight[] = []) {
        const { _lang: lang, text } = this;
        // transform alias to original language
        const fullLengthLang = transformAliasToOrigin([lang])[0];
        const signature = highlightSignature(highlights);

        if (
            text !== this._renderedText
            || fullLengthLang !== this._renderedLang
            || signature !== this._renderedHighlights
        ) {
            const domNode = this.domNode!;
            let code = escapeHTML(getHighlightHtml(text, highlights, true, true));
            for (const [pattern, replacement] of MARKER_RESTORE)
                code = code.replace(pattern, replacement);

            if (
                fullLengthLang
                && /\S/.test(code)
                && loadedLanguages.has(fullLengthLang)
            ) {
                const wrapper = document.createElement('div');
                wrapper.classList.add(`language-${fullLengthLang}`);
                wrapper.innerHTML = code;
                prism.highlightElement(wrapper, false, function (this: HTMLElement) {
                    domNode.innerHTML = this.innerHTML;
                });
            }
            else {
                domNode.innerHTML = code;
            }

            this._renderedText = text;
            this._renderedLang = fullLengthLang;
            this._renderedHighlights = signature;
        }

        this._updateLineNumbers(text);
        // Re-render the math/diagram/html preview too; undo/redo reaches this
        // block only through update(), not inputHandler (#1632).
        this._updatePreviewIfHave(text);
    }

    private _lastLineCount = -1;
    private _lineNumberResizeObserver: ResizeObserver | null = null;

    private _updateLineNumbers(text: string) {
        if (!this.muya.options.codeBlockLineNumbers)
            return;
        const wrapper = this.parent?.lineNumbersWrapper;
        if (wrapper == null)
            return;
        const count = computeLineCount(text);
        if (count !== this._lastLineCount) {
            syncLineNumbersSpans(wrapper, count);
            this._lastLineCount = count;
        }
        this._observeLineNumberResize(wrapper);
    }

    // Re-measure the gutter after any code-block reflow (initial render, font /
    // wrap change, content edit, viewport resize). Fires post-layout, so it
    // can't read stale positions; owns all repositioning.
    private _observeLineNumberResize(wrapper: HTMLElement) {
        if (this._lineNumberResizeObserver != null || typeof ResizeObserver === 'undefined')
            return;
        const codeEl = this.domNode!;
        this._lineNumberResizeObserver = new ResizeObserver(() => {
            if (codeEl.isConnected && wrapper.isConnected)
                repositionLineNumberSpans(wrapper, codeEl);
            else
                this._lineNumberResizeObserver?.disconnect();
        });
        this._lineNumberResizeObserver.observe(codeEl);
    }

    override inputHandler(event: Event): void {
        if (this.isComposed)
            return;

        const textContent = this.domNode!.textContent!;
        const { start, end } = this.getCursor()!;
        const { needRender, text } = this.autoPair(
            event,
            textContent,
            start,
            end,
            false,
            false,
            'codeblock.content',
        );
        this.text = text;

        this._updatePreviewIfHave(text);

        if (needRender) {
            this.setCursor(start!.offset, end!.offset, true);
        }
        else {
            // TODO: throttle render
            this.setCursor(start!.offset, end!.offset, true);
        }
    }

    override enterHandler(event: KeyboardEvent): void {
        event.preventDefault();

        // Shift + Enter to jump out of code block.
        if (event.shiftKey) {
            let cursorBlock;
            const nextContentBlock = this.nextContentInContext();
            if (nextContentBlock) {
                cursorBlock = nextContentBlock;
            }
            else {
                const newNodeState = {
                    name: 'paragraph',
                    text: '',
                };
                const newNode = ScrollPage.loadBlock(newNodeState.name).create(
                    this.muya,
                    newNodeState,
                );
                this.scrollPage?.append(newNode, 'user');
                cursorBlock = newNode.firstChild;
            }
            const offset = adjustOffset(0, cursorBlock, event);
            cursorBlock.setCursor(offset, offset, true);

            return;
        }

        const { tabSize } = this.muya.options;
        const { start } = this.getCursor()!;
        const { text } = this;
        const autoIndent = checkAutoIndent(text, start.offset);
        const indent = getIndentSpace(text, start.offset);

        this.text
            = `${text.substring(0, start.offset)
            }\n${
                autoIndent ? `${indent + ' '.repeat(tabSize)}\n` : ''
            }${indent
            }${text.substring(start.offset)}`;

        let offset = start.offset + 1 + indent.length;

        if (autoIndent)
            offset += tabSize;

        this.setCursor(offset, offset, true);
    }

    override tabHandler(event: KeyboardEvent): void {
        event.preventDefault();
        const { start, end } = this.getCursor()!;
        const { _lang: lang, text } = this;
        const isMarkupCodeContent = /markup|html|xml|svg|mathml/.test(lang);

        if (isMarkupCodeContent) {
            const lastWordBeforeCursor
                = text.substring(0, start.offset).split(/\s+/).pop() ?? '';
            const { tag, isVoid, id, className }
                = parseSelector(lastWordBeforeCursor);

            if (tag) {
                const preText = text.substring(
                    0,
                    start.offset - lastWordBeforeCursor.length,
                );
                const postText = text.substring(end.offset);
                let html = `<${tag}`;
                let startOffset = 0;
                let endOffset = 0;

                switch (tag) {
                    case 'img':
                        html += ' alt="" src=""';
                        startOffset = endOffset = html.length - 1;
                        break;

                    case 'input':
                        html += ' type="text"';
                        startOffset = html.length - 5;
                        endOffset = html.length - 1;
                        break;

                    case 'a':
                        html += ' href=""';
                        startOffset = endOffset = html.length - 1;
                        break;

                    case 'link':
                        html += ' rel="stylesheet" href=""';
                        startOffset = endOffset = html.length - 1;
                        break;
                }

                if (id)
                    html += ` id="${id}"`;

                if (className)
                    html += ` class="${className}"`;

                html += '>';

                if (startOffset === 0 && endOffset === 0)
                    startOffset = endOffset = html.length;

                if (!isVoid)
                    html += `</${tag}>`;

                this.text = preText + html + postText;
                this.setCursor(
                    startOffset + preText.length,
                    endOffset + preText.length,
                    true,
                );
            }
            else {
                this.insertTab();
            }
        }
        else {
            this.insertTab();
        }
    }

    override backspaceHandler(event: KeyboardEvent): void {
        const { start, end } = this.getCursor()!;
        // If the cursor is in the first position of the code block text,
        // when backspace is pressed, this time the code block should be converted to a normal paragraph
        if (start.offset === end.offset && start.offset === 0) {
            event.preventDefault();
            const { text, muya } = this;
            const state = {
                name: 'paragraph',
                text,
            };
            const newNode = ScrollPage.loadBlock(state.name).create(muya, state);
            this.outContainer!.replaceWith(newNode);
            const cursorBlock = newNode.lastContentInDescendant();

            return cursorBlock.setCursor(0, 0, true);
        }
        // The following code should fix a certain bug:
        // when there is one newline(\n) character before cursor.
        // pressing the backspace key should work properly.(compatibility with Firefox)
        if (
            start.offset === end.offset
            && this.text[start.offset - 1] === '\n'
        ) {
            event.preventDefault();
            const { text } = this;
            this.text = text.substring(0, start.offset - 1) + text.substring(start.offset);
            this._updatePreviewIfHave(this.text);
            return this.setCursor(--start.offset, --end.offset, true);
        }
        // The following code is aimed at ensuring compatibility with Firefox.
        // If the preceding character is the end of a token or the second preceding
        // character is the end of a token, the cursor may become dislocated when
        // the backspace key is pressed in Firefox. Therefore, we need to manually
        // simulate the backspace key in order to set the cursor position correctly.
        if (start.offset === end.offset) {
            const { _lang: lang, text } = this;
            // transform alias to original language
            const fullLengthLang = transformAliasToOrigin([lang])[0];
            if (fullLengthLang && /\S/.test(text) && loadedLanguages.has(fullLengthLang)) {
                const tokens = prism.tokenize(text, prism.languages[fullLengthLang]);
                let offset = start.offset;
                let code = '';
                let needRender = false;

                walkTokens(tokens, (token) => {
                    if (offset === 1 && token.type === 'temp-text' && typeof token.content === 'string') {
                        token.content = token.content.substring(1);
                        needRender = true;
                    }
                    else if (offset === token.length && token.type !== 'temp-text' && typeof token.content === 'string') {
                        token.content = token.content.substring(0, token.length - 1);
                        needRender = true;
                    }
                    code += token.content;
                    // string and Token both has length property...
                    offset -= token.length;
                });

                if (needRender) {
                    event.preventDefault();
                    this.text = code;
                    this._updatePreviewIfHave(this.text);
                    return this.setCursor(--start.offset, --end.offset, true);
                }
            }
        }
    }

    override keyupHandler(): void {
        if (this.isComposed)
            return;

        const { anchor, focus } = this.getCursor()!;
        // TODO: @JOCS remove use this.selection directly
        const { anchor: oldAnchor, focus: oldFocus } = this.selection;

        if (
            anchor.offset !== oldAnchor?.offset
            || focus.offset !== oldFocus?.offset
        ) {
            this.setCursor(anchor.offset, focus.offset);
        }
    }
}

export default CodeBlockContent;
