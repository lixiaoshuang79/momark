import type { ReferenceElement } from '@floating-ui/dom';
import type { VNode } from 'snabbdom';
import type { AnnotationModule } from '../../annotation';
import type { IAnnotation, TSelectionSnapshot } from '../../annotation/types';
import type { Muya } from '../../muya';
import type { IBaseOptions } from '../types';
import { EVENT_KEYS, isOsx } from '../../config';
import { getCursorReference } from '../../selection';
import { isKeyboardEvent } from '../../utils';
import { h, patch } from '../../utils/snabbdom';
import BaseFloat from '../baseFloat';

import './index.css';

const COMMAND_KEY = isOsx ? '⌘' : 'Ctrl';

const defaultOptions = {
    placement: 'bottom' as const,
    offsetOptions: {
        mainAxis: 6,
        crossAxis: 0,
        alignmentAxis: 0,
    },
    showArrow: false,
};

/** 卡片头部引文的显示长度（超出部分省略，全文进 `title`）。 */
const QUOTE_PREVIEW_LENGTH = 40;
/** 备注输入框自适应高度：2 行起、10 行封顶（之后内部滚动）。 */
const NOTE_MIN_ROWS = 2;
const NOTE_MAX_ROWS = 10;
/** `.mu-annotation-note` 的行高兜底值（13px × 1.6），正常路径读计算样式。 */
const NOTE_LINE_HEIGHT = 20.8;
/** 计算样式给出的行高小于这个值一定是无单位倍数（不是像素），不可信。 */
const MIN_LINE_HEIGHT = 8;
/**
 * 右栏展开动画 `--ease-panel` 是 .42s，展开会带动编辑区重排；卡片贴的是选区
 * 矩形，必须在面板动画结束后重新贴一次，否则会停在旧位置（方案 §3.2）。
 */
const REPOSITION_DELAY = 480;

/**
 * 备注卡片浮层（方案 §5.1「引擎·UI」）。
 *
 * 只承载备注卡片：订阅工具条发来的 `muya-annotation-request` → 用
 * `findAtSnapshot` 判断新建态 / 编辑态 → 保存时写回 `addFromSnapshot` 或
 * `updateNote`。入口（格式工具条上的「标注」按钮）不在本文件，卡片不做第二套
 * 选中气泡。
 */
export class AnnotationTool extends BaseFloat {
    static pluginName = 'annotationTool';

    public override options: IBaseOptions;

    private _oldVNode: VNode | null = null;
    /**
     * 首次渲染的 patch 目标。它必须带上 `mu-annotation-card` 这个 class：
     * snabbdom 的 `sameVnode()` 比的是 `sel`，`patch(普通 div, 'div.mu-annotation-card')`
     * 不匹配时不会「填进 div」，而是把 div 从父节点里换掉——容器引用会当场失联。
     */
    private _cardContainer: HTMLDivElement = document.createElement('div');

    /** 本次打开的选区快照；关闭即清空。 */
    private _snapshot: TSelectionSnapshot | null = null;
    /** 编辑态命中的标注；null = 新建态。 */
    private _editing: IAnnotation | null = null;
    /** 头部引文（编辑态取标注自己的锚点原文）。 */
    private _quote = '';
    /**
     * 打开瞬间克隆的 DOM Range：卡片位置以它为准。不能用
     * `getCursorReference()` 反复取——文本框拿到焦点后 `document.getSelection()`
     * 就跑到卡片里去了。
     */
    private _range: Range | null = null;
    /**
     * 定位兜底：快照末块（focusBlock）的 DOM 矩形。跨块选区的 DOM 还原有
     * 已知缺陷（引擎 C-23：反向/跨块选区被压缩甚至归零），克隆到的 Range
     * 可能是坏的（rect 全 0）——这时贴「末块的矩形」，即用户松手那一端。
     */
    private _fallbackRect: (() => DOMRect) | null = null;
    private _note: HTMLTextAreaElement | null = null;
    private _saveButton: HTMLButtonElement | null = null;
    private _repositionTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(muya: Muya, options = {}) {
        const name = 'mu-annotation-tool';
        const opts = Object.assign({}, defaultOptions, options);
        super(muya, name, opts);
        this.options = opts;
        this._cardContainer.classList.add('mu-annotation-card');
        this.container!.appendChild(this._cardContainer);
        this.floatBox!.classList.add('mu-annotation-tool-container');
        this.listen();
    }

    override listen() {
        const { eventCenter } = this.muya;
        super.listen();

        eventCenter.subscribe('muya-annotation-request', (snapshot: TSelectionSnapshot) => {
            this._open(snapshot);
        });
    }

    override hide() {
        if (this._repositionTimer) {
            clearTimeout(this._repositionTimer);
            this._repositionTimer = null;
        }

        this._snapshot = null;
        this._editing = null;
        this._quote = '';
        this._range = null;
        this._fallbackRect = null;

        if (this._note)
            this._note.value = '';

        super.hide();
    }

    override destroy() {
        // 待执行的重新贴边定时器晚于销毁触发时会再调 `show()`，而 `floatBox`
        // 已经摘掉，会直接抛错。
        if (this._repositionTimer) {
            clearTimeout(this._repositionTimer);
            this._repositionTimer = null;
        }

        super.destroy();
    }

    /**
     * 标注模块（`muya.ts` 构造期挂在 `editor.annotation` 上）。null 分支只覆盖
     * 「模块未接线」与单测：这种时候卡片整体不出现，而不是留个坏入口。
     */
    private _annotationModule(): AnnotationModule | null {
        return this.muya.editor.annotation ?? null;
    }

    /** 打开卡片：新建态或编辑态（选区完全落在某条已有标注内）。 */
    private _open(snapshot: TSelectionSnapshot | null) {
        const module = this._annotationModule();
        if (!snapshot || !module)
            return;

        // 此刻选区还是编辑器里的真实选区（工具条发事件前刚还原过），所以引文与
        // 贴边矩形都从它取。
        const editing = module.findAtSnapshot(snapshot);
        this._snapshot = snapshot;
        this._editing = editing;
        this._quote = editing ? editing.anchor.quote : this._liveSelectionText();
        this._range = this._cloneLiveRange();

        // 坏 Range 判定：跨块选区点击浮层后，引擎还原出的 DOM 选区可能被压缩/
        // 归零（C-23）——克隆到的 Range rect 全 0，卡片会被贴到 (0,0)。
        if (this._range && ![...this._range.getClientRects()].some(r => r.width > 0))
            this._range = null;

        // 兜底矩形：快照末块的 DOM 矩形（用户松手的一端，一定在视口里）。
        const focusBlock = snapshot.focusBlock as { domNode?: HTMLElement } | undefined;
        if (focusBlock?.domNode) {
            const node = focusBlock.domNode;
            this._fallbackRect = () => node.getBoundingClientRect();
        }

        // 引文兜底：坏选区下实时文本也会读空（同上），退化为快照首块文本——
        // 保存用的锚点取自快照切片，不依赖这里；这里只影响卡片头部预览。
        if (!this._quote) {
            const anchorBlock = snapshot.anchorBlock as { text?: string } | undefined;
            if (anchorBlock?.text)
                this._quote = anchorBlock.text.replace(/\s+/g, ' ').trim();
        }

        this._render();

        if (this._note) {
            this._note.value = editing?.note ?? '';
            this._autoGrow();
        }
        this._syncSaveState();

        const reference = this._reference();
        if (reference)
            this.show(reference);

        this._focusNote();
        this._scheduleReposition();
    }

    private _render() {
        const { _oldVNode: oldVNode, _cardContainer: cardContainer } = this;
        const { i18n } = this.muya;

        const tag = this._editing
            ? `${i18n.t('Annotate')} · ${i18n.t('Edit')}`
            : i18n.t('Annotate');

        const head = h('div.mu-annotation-head', [
            h('span.mu-annotation-tag', tag),
            h(
                'span.mu-annotation-quote',
                { attrs: { title: this._quote } },
                this._quotePreview(),
            ),
        ]);

        const note = h('textarea.mu-annotation-note', {
            attrs: {
                rows: String(NOTE_MIN_ROWS),
                placeholder: i18n.t('Write a note, e.g. this logic is wrong'),
                spellcheck: 'false',
            },
            on: {
                input: () => {
                    this._autoGrow();
                    this._syncSaveState();
                },
                keydown: (event: Event) => this._handleKeydown(event),
            },
        });

        const foot = h('div.mu-annotation-foot', [
            h('span.mu-annotation-hint', `Esc ${i18n.t('Cancel')} · ${COMMAND_KEY}↵ ${i18n.t('Save')}`),
            h(
                'button.mu-annotation-btn',
                {
                    attrs: { type: 'button' },
                    on: { click: () => this.hide() },
                },
                i18n.t('Cancel'),
            ),
            h(
                'button.mu-annotation-btn.primary',
                {
                    attrs: { type: 'button' },
                    on: { click: () => this._save() },
                },
                i18n.t('Save'),
            ),
        ]);

        const card = h('div.mu-annotation-card', [head, note, foot]);

        if (oldVNode)
            patch(oldVNode, card);
        else
            patch(cardContainer, card);

        this._oldVNode = card;
        this._note = cardContainer.querySelector('textarea.mu-annotation-note');
        this._saveButton = cardContainer.querySelector('button.mu-annotation-btn.primary');
    }

    /** 保存并关闭：编辑态改备注，新建态落一条新标注。 */
    private _save() {
        const note = this._note?.value.trim() ?? '';
        const module = this._annotationModule();
        const { _snapshot: snapshot, _editing: editing } = this;

        if (!note || !snapshot || !module)
            return;

        if (editing)
            module.updateNote(editing.id, note);
        else
            module.addFromSnapshot(snapshot, note);

        this.hide();
    }

    private _handleKeydown(event: Event) {
        if (!isKeyboardEvent(event))
            return;

        if (event.key === EVENT_KEYS.Escape) {
            event.preventDefault();
            this.hide();
            return;
        }

        if (event.key === EVENT_KEYS.Enter && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            this._save();
        }
    }

    /** 空备注不允许保存（方案 §3.6「空备注」）。 */
    private _syncSaveState() {
        if (this._saveButton)
            this._saveButton.disabled = !this._note?.value.trim();
    }

    /** 文本框高度随内容增长，2 行起、10 行封顶，超出改为内部滚动。 */
    private _autoGrow() {
        const { _note: note } = this;
        if (!note)
            return;

        // 行高优先读计算样式（CSS 改了字号也不会算歪）；无单位值（`line-height: 1.6`
        // 在未布局环境里会原样返回 "1.6"）与拿不到值时退回常量。
        const computed = Number.parseFloat(getComputedStyle(note).lineHeight);
        const lineHeight = Number.isFinite(computed) && computed >= MIN_LINE_HEIGHT
            ? computed
            : NOTE_LINE_HEIGHT;
        const min = lineHeight * NOTE_MIN_ROWS;
        const max = lineHeight * NOTE_MAX_ROWS;

        note.style.height = 'auto';
        note.style.height = `${Math.min(Math.max(note.scrollHeight, min), max)}px`;
        note.style.overflowY = note.scrollHeight > max ? 'auto' : 'hidden';
    }

    private _focusNote() {
        const { _note: note } = this;
        if (!note)
            return;

        try {
            note.focus({ preventScroll: true });
        }
        catch {
            note.focus();
        }
        note.setSelectionRange(note.value.length, note.value.length);
    }

    /** 卡片贴边参照：优先用打开时的选区 Range（跨块时即整段外接矩形）。 */
    private _reference(): ReferenceElement | null {
        const { _range: range } = this;

        if (!range) {
            const cursor = getCursorReference();
            if (cursor)
                return cursor;
            if (this._fallbackRect)
                return { getBoundingClientRect: this._fallbackRect };
            return null;
        }

        return {
            // 跨块长选区的外接矩形高几百像素，卡片贴它会被 flip/定位推到视口外
            // （用户实测：选中一大段后点「标注」像"没反应"）。改用**选区末行**
            // 的矩形做参照——那是用户松手的位置，一定在视口里，语义也更对。
            getBoundingClientRect: () => {
                const rects = [...range.getClientRects()].filter((r) => r.width > 0);
                return rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
            },
        };
    }

    private _scheduleReposition() {
        if (this._repositionTimer)
            clearTimeout(this._repositionTimer);

        this._repositionTimer = setTimeout(() => {
            this._repositionTimer = null;
            if (!this.status || !this.floatBox)
                return;

            const reference = this._reference();
            if (!reference)
                return;

            // Range 被整块换掉（重载 / 重渲染）后矩形退化成 0，这时贴边没有意义。
            const rect = reference.getBoundingClientRect();
            if (!rect || (!rect.width && !rect.height))
                return;

            this.show(reference);
        }, REPOSITION_DELAY);
    }

    private _quotePreview(): string {
        const { _quote: quote } = this;

        return quote.length > QUOTE_PREVIEW_LENGTH
            ? `${quote.slice(0, QUOTE_PREVIEW_LENGTH)}…`
            : quote;
    }

    /** 选区渲染文本（单行预览用，压掉换行）。 */
    private _liveSelectionText(): string {
        return document.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
    }

    private _cloneLiveRange(): Range | null {
        const selection = document.getSelection();
        if (!selection || !selection.rangeCount)
            return null;

        return selection.getRangeAt(0).cloneRange();
    }
}

export default AnnotationTool;
