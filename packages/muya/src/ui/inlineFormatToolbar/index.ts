import type { VNode } from 'snabbdom';
import type { AnnotationModule } from '../../annotation';
import type { Muya } from '../../index';
import type { Token } from '../../inlineRenderer/types';
import type { ISelection } from '../../selection/types';
import type { IBaseOptions } from '../types';

import type { FormatToolIcon } from './config';
import Format from '../../block/base/format';
import { getCursorReference } from '../../selection';
import { isKeyboardEvent } from '../../utils';
import { h, patch } from '../../utils/snabbdom';
import BaseFloat from '../baseFloat';
import icons from './config';
import './index.css';

/** Default float options for inline format toolbar */
const defaultOptions = {
    placement: 'top' as const,
    offsetOptions: {
        mainAxis: 5,
        crossAxis: 0,
        alignmentAxis: 0,
    },
    showArrow: false,
};

/** Format keyboard shortcuts without shift modifier */
const FORMAT_SHORTCUTS = {
    b: 'strong',
    i: 'em',
    u: 'u',
    d: 'del',
    e: 'inline_code',
    l: 'link',
} as const;

/** Format keyboard shortcuts with shift modifier */
const FORMAT_SHORTCUTS_SHIFT = {
    h: 'mark',
    e: 'inline_math',
    i: 'image',
    r: 'clear',
} as const;

/** Keys that should not trigger toolbar hiding */
const NON_EDITING_KEYS = new Set([
    'Shift',
    'Control',
    'Meta',
    'Alt',
    'Tab',
]);

/**
 * Inline format toolbar for text formatting
 * Provides quick access to text formatting options like bold, italic, etc.
 * Appears when text is selected
 */
export class InlineFormatToolbar extends BaseFloat {
    static pluginName = 'formatPicker';
    // Passive float: must not capture nav keys, or Enter over a selection is
    // swallowed while it's shown (#3196).
    public override capturesContentKeydown = false;

    /** Previous virtual node for patching */
    private _oldVNode: VNode | null = null;

    /** The block containing the selected text */
    private _block: Format | null = null;

    /** Currently applied formats in the selection */
    private _formats: Token[] = [];

    /** Toolbar configuration options */
    public override options: IBaseOptions;

    /**
     * A cross-block selection is in progress: the toolbar is showing the
     * annotation action alone (see `listen()`).
     */
    private _crossBlock = false;
    /**
     * 最近一次"有效实时选区"的快照（selectionchange 通道在选区还在时捕获）。
     *
     * 首屏后的异步重渲（innerHTML patch）会把绑在旧 DOM 节点上的原生选区清掉——
     * 用户"打开文档后第一次拖选就去点「标注」"时 `getSelection()` 已经为空，
     * 快照整段作废（表现为点了没反应）。点按钮时用这份缓存兜底。
     */
    private _lastLiveSelection: Pick<ISelection, 'anchor' | 'focus'> | null = null;

    /** Format tool icons configuration */
    private _icons: FormatToolIcon[] = icons;

    /** Container element for the format toolbar */
    private _formatContainer: HTMLDivElement = document.createElement('div');

    /**
     * Create inline format toolbar instance
     * @param muya - Muya editor instance
     * @param options - Toolbar options
     */
    constructor(muya: Muya, options = {}) {
        const name = 'mu-format-picker';
        const opts = Object.assign({}, defaultOptions, options);
        super(muya, name, opts);
        this.options = opts;
        this.container!.appendChild(this._formatContainer);
        this.floatBox!.classList.add('mu-format-picker-container');
        this.listen();
    }

    /**
     * Listen to format picker events and keyboard shortcuts
     */
    override listen() {
        const { eventCenter, domNode, editor } = this.muya;
        super.listen();

        eventCenter.subscribe('muya-format-picker', ({ reference, block }) => {
            if (reference) {
                this._block = block;
                this._formats = block.getFormatsInRange().formats;
                requestAnimationFrame(() => {
                    this.show(reference);
                    this._render();
                });
            }
            else {
                this.hide();
            }
        });

        // 点浮层按钮时，浏览器的默认行为会在 mousedown 阶段就把正文选区塌陷
        // （塌到点击处最近的文本）——跨块长选区会被毁成空块 offset 0，随后的
        // 快照全部作废（卡片引文空、定位贴到 (0,0)）。preventDefault 保住选区；
        // 这也是格式化按钮既有的"点击后还能取回选区"能成立的前提。
        eventCenter.attachDOMEvent(this.container!, 'mousedown', (event) => {
            event.preventDefault();
        });

        // 原生 selectionchange 通道（拖动选择 / 跨块选区都走这里）。
        //
        // 引擎的 `selection-change` 只在同块路径发出：`editor/index.ts::_dispatchEvents`
        // 对 `!isSelectionInSameBlock` 直接 return，块处理器（click/keyup）不执行，
        // 跨块选区永远到不了上面那条订阅；而拖动选择（mousedown→move→mouseup）不产生
        // click 事件，clickHandler 也不会跑——两种情况下工具条都不会弹（用户实测：
        // 拖选一大段无法标注）。这里直接听浏览器原生事件，rAF 合并后评估选区：
        //  - 选区必须落在编辑器内（排除面板输入框等处的选区变化）；
        //  - 同块 → 补发 `muya-format-picker`（与 clickHandler 同一条下游链路）；
        //  - 跨块 → 以标注单项显示（格式按钮没有跨块实现，隐藏它们是诚实的能力映射）；
        //  - 折叠 → 仅复位跨块态（同块态的隐藏由既有 click/keyup 逻辑负责）。
        let selectionRafPending = false;
        eventCenter.attachDOMEvent(document, 'selectionchange', () => {
            if (selectionRafPending)
                return;
            selectionRafPending = true;
            requestAnimationFrame(() => {
                selectionRafPending = false;

                const nativeSelection = document.getSelection();
                if (!nativeSelection || nativeSelection.isCollapsed || !nativeSelection.anchorNode
                    || !this.muya.domNode.contains(nativeSelection.anchorNode)) {
                    if (this._crossBlock) {
                        this._crossBlock = false;
                        this.hide();
                    }
                    return;
                }

                const selection = this.muya.editor.selection.getSelection();
                if (!selection || selection.isCollapsed)
                    return;

                // 此刻选区还在——捕获一份，供点按钮时的兜底（见 `_lastLiveSelection`）。
                this._lastLiveSelection = {
                    anchor: selection.anchor,
                    focus: selection.focus,
                };

                const enabled = this._annotationModule()?.enabled;

                if (selection.isSelectionInSameBlock) {
                    const block = selection.anchor.block;
                    const reference = getCursorReference();
                    if (reference && block)
                        this.muya.eventCenter.emit('muya-format-picker', { reference, block });
                }
                else if (enabled) {
                    this._crossBlock = true;
                    this._block = null;
                    this._formats = [];

                    const reference = getCursorReference();
                    if (reference)
                        this.show(reference);

                    this._render();
                }
            });
        });

        // While open, re-sync the highlight from the selection's current
        // formats — this is how formats applied outside the toolbar (menu /
        // command / shortcut) light up their buttons. Single-block tool, so
        // ignore collapsed / cross-block selections.
        //
        // The same event is the only way a cross-block selection can reach the
        // toolbar: no block handler runs for it (`editor/index.ts::_dispatchEvents`
        // bails on `!isSelectionInSameBlock`), so `muya-format-picker` never
        // fires. We show the toolbar ourselves with the annotation action alone
        // — format buttons have no cross-block implementation, so hiding them
        // is the honest capability map.
        eventCenter.subscribe('selection-change', ({ formats, isCollapsed, isSelectionInSameBlock }) => {
            const enabled = this._annotationModule()?.enabled;

            if (!isSelectionInSameBlock) {
                if (isCollapsed || !enabled) {
                    if (this._crossBlock) {
                        this._crossBlock = false;
                        this.hide();
                    }
                    return;
                }

                this._crossBlock = true;
                this._block = null;
                this._formats = [];

                const reference = getCursorReference();
                if (reference)
                    this.show(reference);

                this._render();
                return;
            }

            if (this._crossBlock) {
                // Back inside a single block. The cross-block render carries no
                // `_block`, so keeping it up would expose format buttons whose
                // target is null; collapse it instead and let the block's own
                // click / keyup handler re-open the full toolbar.
                this._crossBlock = false;
                this.hide();
                return;
            }

            if (!this.status || isCollapsed)
                return;

            this._formats = formats;
            this._render();
        });

        eventCenter.attachDOMEvent(domNode, 'keydown', (event) => {
            this._handleKeydown(event, editor);
        });
    }

    /**
     * Handle keyboard events for format shortcuts and toolbar hiding
     * @param event - Keyboard event
     * @param editor - Editor instance
     */
    private _handleKeydown(event: Event, editor: typeof this.muya.editor) {
        if (!isKeyboardEvent(event))
            return;

        const { key, shiftKey, metaKey, ctrlKey } = event;
        const selection = editor.selection.getSelection();
        if (!selection)
            return;

        const { anchor, isSelectionInSameBlock } = selection;
        const anchorBlock = anchor.block;

        if (!isSelectionInSameBlock)
            return;

        // Hide toolbar on editing operations
        if (!(anchorBlock instanceof Format) || (!metaKey && !ctrlKey)) {
            this._hideOnEditingKey(key, metaKey, ctrlKey);
            return;
        }

        // Handle format shortcuts
        this._handleFormatShortcut(event, key, shiftKey, anchorBlock);
    }

    /**
     * Hide toolbar when an editing key is pressed
     * @param key - Key name
     * @param metaKey - Meta key state
     * @param ctrlKey - Control key state
     */
    private _hideOnEditingKey(key: string, metaKey: boolean, ctrlKey: boolean) {
        // Don't hide if it's a modifier/navigation key or if format shortcut is pressed
        if (NON_EDITING_KEYS.has(key) || metaKey || ctrlKey)
            return;

        if (this.status) {
            this.hide();
        }
    }

    /**
     * Handle format keyboard shortcuts
     * @param event - Keyboard event
     * @param key - Key name
     * @param shiftKey - Shift key state
     * @param anchorBlock - Anchor block
     */
    private _handleFormatShortcut(
        event: KeyboardEvent,
        key: string,
        shiftKey: boolean,
        anchorBlock: Format,
    ) {
        const shortcuts = shiftKey ? FORMAT_SHORTCUTS_SHIFT : FORMAT_SHORTCUTS;
        const formatType = shortcuts[key as keyof typeof shortcuts];

        if (formatType) {
            event.preventDefault();
            anchorBlock.format(formatType);
        }
    }

    /**
     * The annotation module owns the「启用内容标注」flag; the toolbar only
     * reflects it. `editor.annotation` is wired by `muya.ts` at construction
     * time — the null branch only covers "module not wired up yet" (and the
     * unit tests), where the entry point stays hidden instead of dangling.
     */
    private _annotationModule(): AnnotationModule | null {
        return this.muya.editor.annotation ?? null;
    }

    /**
     * Icons for the current render: the cross-block channel offers the
     * annotation action alone, and a disabled annotation module drops it from
     * the regular toolbar (every other button is untouched).
     */
    private _visibleIcons(): FormatToolIcon[] {
        const enabled = !!this._annotationModule()?.enabled;

        return this._icons.filter(icon =>
            icon.type === 'annotation' ? enabled : !this._crossBlock,
        );
    }

    /**
     * Render the format toolbar UI
     */
    private _render() {
        const { _oldVNode: oldVNode, _formatContainer: formatContainer, _formats: formats } = this;
        const { i18n } = this.muya;

        const children: VNode[] = [];

        this._visibleIcons().forEach((icon) => {
            // The annotation action is not a format, so a divider groups it
            // apart from the format buttons. Cross-block renders it alone — the
            // divider has nothing to separate there.
            if (icon.type === 'annotation' && !this._crossBlock)
                children.push(h('li.divider'));

            children.push(this._createIconItem(icon, formats, i18n));
        });

        const vnode = h('ul', children);

        patch(oldVNode || formatContainer, vnode);
        this._oldVNode = vnode;
    }

    /**
     * Create a format icon item
     * @param icon - Icon configuration
     * @param formats - Currently applied formats
     * @param i18n - Internationalization instance
     */
    private _createIconItem(icon: FormatToolIcon, formats: Token[], i18n: typeof this.muya.i18n) {
        const iconElement = h(
            'i.icon',
            h(
                'i.icon-inner',
                {
                    style: {
                        'background': `url(${icon.icon}) no-repeat`,
                        'background-size': '100%',
                    },
                },
                '',
            ),
        );

        const iconWrapper = h('div.icon-wrapper', iconElement);

        const isActive = formats.some(
            f => f.type === icon.type || (f.type === 'html_tag' && f.tag === icon.type),
        );

        const itemSelector = `li.item.${icon.type}${isActive ? '.active' : ''}`;

        // The annotation action is not a format and carries no shortcut, so its
        // tooltip is the label alone (no dangling second line).
        const shortcut = 'shortcut' in icon ? icon.shortcut : '';
        const label = i18n.t(icon.tooltip);

        return h(
            itemSelector,
            {
                attrs: {
                    title: shortcut ? `${label}\n${shortcut}` : label,
                },
                on: {
                    click: event => this._selectItem(event, icon),
                },
            },
            [iconWrapper],
        );
    }

    /**
     * Handle format item selection
     * @param event - Click event
     * @param item - Selected format tool icon
     */
    private _selectItem(event: Event, item: FormatToolIcon) {
        event.preventDefault();
        event.stopPropagation();

        const { selection } = this.muya.editor;
        const { anchor, focus, anchorBlock, anchorPath, focusBlock, focusPath } = selection;

        // 标注是纯动作入口：不进 block.format()，也不重算 _formats / 重渲染工具条，
        // 避免非格式动作混进格式态同步逻辑。早返回也让跨块（_block 为 null）安全。
        //
        // 快照必须从**实时 DOM 选区**解析（`selection.getSelection()`），不能读
        // 开头解构的引擎缓存——拖动选择不更新缓存，里面是上一次点击/键盘的残留
        // 位置（跨块拖选后实测为空块 offset 0，整条快照作废：引文空、卡片贴 (0,0)）。
        if (item.type === 'annotation') {
            const fresh = selection.getSelection();
            // 首屏后的异步重渲可能已把原生选区清掉（选区绑在旧节点上）——回退到
            // selectionchange 通道在选区还在时缓存的那一份（见 `_lastLiveSelection`）。
            const live: Pick<ISelection, 'anchor' | 'focus'> | null
                = fresh && !fresh.isCollapsed ? fresh : this._lastLiveSelection;
            if (!live)
                return;

            // 与既有格式化路径同一手法：点击浮层可能丢 DOM 选区，先还原再取快照。
            selection.setSelection(live.anchor, live.focus);

            this.muya.eventCenter.emit('muya-annotation-request', {
                anchor: live.anchor,
                focus: live.focus,
                anchorBlock: live.anchor.block,
                focusBlock: live.focus.block,
                anchorPath: live.anchor.path,
                focusPath: live.focus.path,
            });
            this.hide();

            return;
        }

        if (!anchor || !focus || !anchorBlock || !focusBlock)
            return;

        // Restore selection before formatting
        selection.setSelection(
            { offset: anchor.offset, block: anchorBlock, path: anchorPath },
            { offset: focus.offset, block: focusBlock, path: focusPath },
        );

        this._block!.format(item.type);

        // Hide toolbar for link and image, re-render for other formats
        if (/link|image/.test(item.type)) {
            this.hide();
        }
        else {
            this._formats = this._block!.getFormatsInRange().formats;
            this._render();
        }
    }
}
