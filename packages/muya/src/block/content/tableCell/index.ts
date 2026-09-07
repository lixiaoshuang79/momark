import type { Muya } from '../../../muya';
import type { IRenderCursor } from '../../../selection/types';
import type Table from '../../gfm/table';
import type Cell from '../../gfm/table/cell';
import type Row from '../../gfm/table/row';
import type TableInner from '../../gfm/table/table';
import { EVENT_KEYS, isOsx } from '../../../config';
import { isKeyboardEvent } from '../../../utils';
import Format from '../../base/format';
import { ScrollPage } from '../../scrollPage';

class TableCellContent extends Format {
    private _hasZeroWidthSpaceAtBeginning: boolean = false;

    static override blockName = 'table.cell.content';

    static create(muya: Muya, text: string) {
        const content = new TableCellContent(muya, text);

        return content;
    }

    get table() {
        return this.closestBlock('table') as Table;
    }

    private get _tableInner() {
        return this.closestBlock('table.inner') as TableInner;
    }

    private get _row() {
        return this.closestBlock('table.row') as Row;
    }

    private get _cell() {
        return this.closestBlock('table.cell') as Cell;
    }

    constructor(muya: Muya, text: string) {
        super(muya, text);
        this.classList = [...this.classList, 'mu-table-cell-content'];
        this.createDomNode();
    }

    override getAnchor() {
        return this.table;
    }

    override update(cursor?: IRenderCursor, highlights = []) {
        const result = this.inlineRenderer.patch(this, cursor, highlights);
        // 空单元格预置真实 \u200B 文本节点（非 CSS 伪元素）：
        // Chromium/Blink 在嵌套 contenteditable 中对空单元格发起的 IME
        // 组合会把锚点规范化到下一格开头（字打进隔壁格）——真实文本节点
        // 让组合锚点固定在格内。仅改 DOM、不进 state，序列化不受影响。
        this._ensureZeroWidthPlaceholder();
        return result;
    }

    private _ensureZeroWidthPlaceholder() {
        const { domNode, text } = this;
        if (domNode && text === '' && !domNode.hasChildNodes()) {
            domNode.appendChild(document.createTextNode('\u200B'));
        }
    }

    /**
     * 剔除并入 state 的残留占位 \u200B。
     * ends=false 只剥前导（占位永远在开头，非组合输入路径）；
     * ends=true 同时剥尾部（Safari 老路径：提交文本插在占位之前）。
     */
    private _stripZeroWidth(ends = false) {
        const { text } = this;
        const cleaned = ends
            ? text.replace(/^\u200B+/, '').replace(/\u200B+$/, '')
            : text.replace(/^\u200B+/, '');
        if (cleaned === text)
            return false;

        this.text = cleaned;
        return true;
    }

    /** 剥除后把 DOM 与 state 对齐：组合期间浏览器写进文本节点的前导 \u200B，
     *  增量 op 可能不触发重渲染，此处显式 patch 一次并兜底清掉残留字符。 */
    private _reconcilePlaceholderDom() {
        this.update();
        const { domNode, text } = this;
        if (!domNode || !text || !domNode.textContent?.startsWith('\u200B'))
            return;

        const first = domNode.firstChild;
        if (
            first
            && first.nodeType === Node.TEXT_NODE
            && first.textContent?.startsWith('\u200B')
        ) {
            first.textContent = first.textContent.replace(/^\u200B+/, '');
        }
    }

    /** 组合结束后的光标落位：muya 的渲染/选区恢复链是异步多拍
     *  （组合前光标快照会在若干 rAF 后重放），连续兜底几次，
     *  最后一次落位必然发生在渲染链结束之后。 */
    private _settleCaretAtEnd() {
        this._placeCaretAtEnd();
        requestAnimationFrame(() => {
            this._placeCaretAtEnd();
            setTimeout(() => this._placeCaretAtEnd(), 0);
            setTimeout(() => this._placeCaretAtEnd(), 60);
        });
    }

    override inputHandler(event: Event) {
        super.inputHandler(event);
        // 组合输入期间（isComposing）与 compositionend 本身都交给 composeHandler
        // 统一剔除占位符并落光标——若这里提前剥掉 \u200B，compositionend 将无
        // 占位可剥而跳过光标落位（Chromium 中 input 事件先于 compositionend）。
        if (event.type === 'compositionend')
            return;
        if ('isComposing' in event && (event as InputEvent).isComposing)
            return;
        // ASCII/删除等非组合输入也可能把占位 \u200B 并入 state，统一剔除；
        // 剔除触发的重渲染会把光标快照回放回块级起点，与组合输入同样落位兜底。
        if (this._stripZeroWidth(false)) {
            this._reconcilePlaceholderDom();
            this._settleCaretAtEnd();
        }
    }

    /** 直接把 DOM 选区落到本格最深末尾文本节点（绕过 muya 块级光标映射，
     *  后者在重渲染后可能回退到单元格块级选区）。 */
    private _placeCaretAtEnd() {
        const { domNode } = this;
        if (!domNode)
            return;

        let last: Node | null = domNode;
        while (last && last.lastChild)
            last = last.lastChild;

        if (!last)
            return;

        const isText = last.nodeType === Node.TEXT_NODE;
        const range = document.createRange();
        if (isText) {
            range.setStart(last, last.textContent?.length ?? 0);
        }
        else {
            range.setStartBefore(last);
            range.collapse(false);
        }
        range.collapse(true);
        const selection = window.getSelection();
        if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }

    private _findNextRow() {
        const { _row: row } = this;

        return row.next || null;
    }

    private _findPreviousRow() {
        const { _row: row } = this;

        return row.prev || null;
    }

    private _shiftEnter(event: Event) {
        event.preventDefault();

        const { start, end } = this.getCursor()!;
        const { text } = this;

        const br = '<br/>';

        this.text
            = text.substring(0, start.offset) + br + text.substring(end.offset);
        const offset = start.offset + br.length;
        this.setCursor(offset, offset, true);
    }

    private _commandEnter(event: Event) {
        event.preventDefault();

        const offset = this._tableInner.offset(this._row);
        const cursorBlock = this.table.insertRow(
            offset + 1, /* Because insert after the current row */
        );
        cursorBlock.setCursor(0, 0);
    }

    private _normalEnter(event: Event) {
        event.preventDefault();

        const nextRow = this._findNextRow();
        const { _row: row } = this;
        let cursorBlock = null;
        if (nextRow) {
            cursorBlock = nextRow.firstContentInDescendant();
        }
        else {
            const lastCellContent = row.lastContentInDescendant();
            const nextContent = lastCellContent?.nextContentInContext();

            if (nextContent) {
                cursorBlock = nextContent;
            }
            else {
                const state = {
                    name: 'paragraph',
                    text: '',
                };

                const newParagraphBlock = ScrollPage.loadBlock('paragraph').create(
                    this.muya,
                    state,
                );
                this.scrollPage?.append(newParagraphBlock, 'user');
                cursorBlock = newParagraphBlock.firstContentInDescendant();
            }
        }

        cursorBlock.setCursor(0, 0, true);
    }

    override enterHandler(event: Event) {
        if (!isKeyboardEvent(event))
            return;

        if (event.shiftKey)
            return this._shiftEnter(event);
        else if ((isOsx && event.metaKey) || (!isOsx && event.ctrlKey))
            return this._commandEnter(event);
        else
            return this._normalEnter(event);
    }

    override arrowHandler(event: Event) {
        if (!isKeyboardEvent(event))
            return;

        const previousRow = this._findPreviousRow();
        const nextRow = this._findNextRow();
        const { table, _cell: cell, _row: row } = this;
        const offset = row.offset(cell);
        const tablePrevContent = table.prev
            ? table.prev.lastContentInDescendant()
            : null;
        const tableNextContent = table.next
            ? table.next.firstContentInDescendant()
            : null;

        if (event.key === EVENT_KEYS.ArrowUp) {
            event.preventDefault();
            if (previousRow) {
                const cursorBlock = (
                    previousRow.find(offset) as Cell
                ).firstContentInDescendant();

                if (cursorBlock) {
                    const cursorOffset = cursorBlock.text.length;
                    cursorBlock.setCursor(cursorOffset, cursorOffset, true);
                }
            }
            else if (tablePrevContent) {
                const cursorOffset = tablePrevContent.text.length;
                tablePrevContent.setCursor(cursorOffset, cursorOffset, true);
            }
        }
        else if (event.key === EVENT_KEYS.ArrowDown) {
            event.preventDefault();

            if (nextRow) {
                const cursorBlock = (
                    nextRow.find(offset) as Cell
                ).firstContentInDescendant();

                cursorBlock?.setCursor(0, 0, true);
            }
            else {
                let cursorBlock = null;
                if (tableNextContent) {
                    cursorBlock = tableNextContent;
                }
                else {
                    const state = {
                        name: 'paragraph',
                        text: '',
                    };

                    const newParagraphBlock = ScrollPage.loadBlock('paragraph').create(
                        this.muya,
                        state,
                    );
                    this.scrollPage?.append(newParagraphBlock, 'user');
                    cursorBlock = newParagraphBlock.firstContentInDescendant();
                }

                cursorBlock.setCursor(0, 0, true);
            }
        }
        else {
            super.arrowHandler(event);
        }
    }

    override backspaceHandler(event: Event) {
        const { start, end } = this.getCursor()!;
        const previousContentBlock = this.previousContentInContext();

        if (start.offset !== 0 || start.offset !== end.offset)
            return super.backspaceHandler(event);

        event.preventDefault();
        event.stopPropagation();

        if (
            !previousContentBlock
            || (previousContentBlock.blockName !== 'table.cell.content'
                && this.table.isEmpty())
        ) {
            const state = {
                name: 'paragraph',
                text: '',
            };
            const newParagraphBlock = ScrollPage.loadBlock('paragraph').create(
                this.muya,
                state,
            );
            this.table.replaceWith(newParagraphBlock);
            newParagraphBlock.firstChild.setCursor(0, 0);
        }
        else {
            const offset = previousContentBlock.text.length;
            previousContentBlock.setCursor(offset, offset, true);
        }
    }

    override tabHandler(event: Event) {
        event.preventDefault();
        event.stopPropagation();

        // Shift+Tab back-navigates inside the table (header row's first cell
        // stays put when there is no previous content).
        // Read shiftKey directly — pointer Tab is not a thing, so callers
        // always pass a KeyboardEvent in practice. The structural check just
        // keeps unit tests that pass a partial event object passing.
        const isShiftTab = 'shiftKey' in event && event.shiftKey === true;
        const cursorBlock = isShiftTab
            ? this.previousContentInContext()
            : this.nextContentInContext();

        if (cursorBlock)
            cursorBlock.setCursor(0, 0, true);
    }

    // 空单元格输入中文的历史 bug（Safari 表格错乱 / Chromium 字钻进隔壁格），
    // 统一解法：渲染层在空格里预置真实 \u200B 文本节点固定 IME 组合锚点，
    // 组合结束后剔除并入 state 的前导 \u200B（仅 state，DOM 由重渲染接管）。
    override composeHandler(event: Event) {
        super.composeHandler(event);
        if (event.type === 'compositionstart' && this.text === '') {
            // 占位 \u200B 已在渲染层预置；此处兜底（如程序化插入的空格），
            // 且仅在 DOM 真空时才写入，避免重建文本节点把组合锚点挤掉。
            this._hasZeroWidthSpaceAtBeginning = true;
            this._ensureZeroWidthPlaceholder();
        }
        else if (event.type === 'compositionend' && this._hasZeroWidthSpaceAtBeginning) {
            this._hasZeroWidthSpaceAtBeginning = false;
            // 组合文本插在占位节点内（Chromium：\u200B 在前）或占位之前
            // （Safari 老路径：\u200B 在后），DOM 同步回 state 后两端都剥；
            // 变更渲染回调会在本次任务后重放组合前的光标快照，故光标落位
            // 延后一拍且直接落 DOM 选区，保证最终停在提交文本末尾。
            if (this._stripZeroWidth(true)) {
                this._reconcilePlaceholderDom();
                this._settleCaretAtEnd();
            }
        }
    }
}

export default TableCellContent;
