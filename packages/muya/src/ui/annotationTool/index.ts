import type { ReferenceElement } from '@floating-ui/dom';
import type { VNode } from 'snabbdom';
import type { AnnotationModule } from '../../annotation';
import { selectionToRanges } from '../../annotation/anchor';
import type { IAnnotation, TSelectionSnapshot } from '../../annotation/types';
import type { Muya } from '../../muya';
import type { IBaseOptions } from '../types';
import { collectablePhrase, composeNote, QUICK_PHRASE_MAX_COUNT, QUICK_PHRASE_MAX_LEN } from '../../annotation/quickPhrase';
import { EVENT_KEYS, isOsx } from '../../config';
import { getCursorReference } from '../../selection';
import { isKeyboardEvent, isMouseEvent } from '../../utils';
import { h, patch } from '../../utils/snabbdom';
import BaseFloat from '../baseFloat';

import './index.css';

const COMMAND_KEY = isOsx ? '⌘' : 'Ctrl';

/** 卡片头部「管理常用语…」的图标（原型 ICON.qpmanage：两条短语 + 一支斜落下来的铅笔）。 */
const GEAR_ICON
    = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 4.3h11.2"/><path d="M2.4 7.9h4.8"/><path d="M11.5 6.5l1.4 1.4-4.4 4.4-1.9.5.5-1.9z"/></svg>';

/** 底栏情境提示的五个状态：同一位置交叉淡入 120ms 轮换（原型 §3.2 #25）。 */
const HINT_STATES = ['default', 'hover', 'alt', 'saved', 'failed', 'typed'] as const;
type THintState = (typeof HINT_STATES)[number];

/** `muya-annotation-saved` 的载荷：`origin` 供桌面飞点动画起点，`mode` 区分保存路径。 */
export interface IAnnotationSavedPayload {
    origin: { x: number; y: number } | null;
    mode: 'chip' | 'manual';
}

/** `muya-annotation-phrase-add` 的载荷。 */
export interface IAnnotationPhraseAddPayload {
    phrase: string;
}

const defaultOptions = {
    placement: 'bottom' as const,
    offsetOptions: {
        mainAxis: 6,
        crossAxis: 0,
        alignmentAxis: 0,
    },
    showArrow: false,
};

/** ⌥ 按住这么久之后浮出数字角标（原型 §3.2 #26）。 */
const ALT_REVEAL_DELAY = 120;
/** chip 落印（变实心 accent）到真正保存之间的停顿（#17 → #18）。 */
const CHIP_SAVE_DELAY = 100;
/** 落印态保持时长。 */
const STAMP_DURATION = 200;
/** 墨染动画时长（随后把节点摘掉）。 */
const INK_DURATION = 320;
/** 新 chip 出生动画时长。 */
const BORN_DURATION = 340;
/** 保存后正文高亮接力：离场开始后 60ms 点亮（#20）。 */
const RELAY_DELAY = 60;
/** 高亮接力动画时长（放完把一次性 class 摘掉，动画回落成常驻底色）。 */
const RELAY_DURATION = 560;
/** 入场动效总时长（最长一路是 300ms 滑动 + 320ms 的 chip 错峰）。 */
const ENTER_DURATION = 620;
/** 等 BaseFloat 写上位置的最多帧数；等不到就按默认方向入场，不能让卡片一直隐身。 */
const ENTER_MAX_FRAMES = 40;
/** 底栏「已加入」临时提示的保持时长。 */
const HINT_FLASH_DURATION = 1600;
/** 底栏「保存失败」提示的保持时长（比「已加入」短一档：失败要尽快回到可操作态）。 */
const FAILED_HINT_DURATION = 2200;
/** 备注输入框自适应高度：3 行起、10 行封顶（之后内部滚动）。 */
const NOTE_MIN_ROWS = 3;
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
 *
 * v8 起卡片是四段结构：头（标注 + 管理常用语）→ 常用语 chips → 输入框 → 底栏。
 * 点一枚 chip 就是「以该短语为备注完成标注」——手写过的字由 `composeNote` 合并，
 * 一个字都不会丢。
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
    /**
     * 打开瞬间测得的贴边矩形（**数值快照**，不是 Range）。
     *
     * 卡片打开时会立刻给选区加 pending 高亮（选中态），那会让块重渲染、换掉
     * DOM 节点——此时 `_range` 指向已移除的节点，再量就是 0×0，卡片会贴到
     * 屏幕左上角。所以位置在加高亮**之前**就量成普通对象，整个卡片生命周期
     * 都用它。
     */
    private _referenceRect: {
        top: number
        bottom: number
        left: number
        right: number
        width: number
        height: number
        x: number
        y: number
    } | null = null;
    /** 编辑态命中的标注；null = 新建态。 */
    private _editing: IAnnotation | null = null;
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

    /** 常用语列表（打开时从模块取，桌面偏好变化时就地刷新）。 */
    private _phrases: string[] = [];
    private _chipEls: HTMLButtonElement[] = [];
    private _quickRow: HTMLElement | null = null;
    private _hintEl: HTMLElement | null = null;
    private _collectButton: HTMLButtonElement | null = null;
    /** 本次渲染要播出生动画的新 chip。 */
    private _bornPhrases = new Set<string>();
    /** hover 预演中的短语（输入框为空时临时充当 placeholder）。 */
    private _hoveredPhrase: string | null = null;
    private _altOn = false;
    private _altTimer: ReturnType<typeof setTimeout> | null = null;
    /** chip 点击后的落印 → 保存接力。 */
    private _chipSaveTimer: ReturnType<typeof setTimeout> | null = null;
    /** 底栏提示的临时覆盖态（「已加入 · ⌥N」/「保存失败」），null = 走情境态。 */
    private _hintOverride: THintState | null = null;
    /** 失败提示的回落定时器。 */
    private _failHintTimer: ReturnType<typeof setTimeout> | null = null;
    /** 卡片自己的退场在途标记（BaseFloat 内部还有一个同义的私有标记）。 */
    private _exiting = false;
    private _enterRaf: number | null = null;
    /** 卡片生命周期内的短命定时器（隐藏 / 销毁时一并清）。 */
    private _timers = new Set<ReturnType<typeof setTimeout>>();
    /** 正文高亮接力用的定时器：动画打在正文的 span 上，卡片收起后仍要跑完。 */
    private _relayTimers = new Set<ReturnType<typeof setTimeout>>();

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
        // 桌面偏好变化（设置弹窗改动 / 「＋ 存为常用语」写盘回执）：卡片开着就地刷新
        eventCenter.subscribe('annotation-quick-phrases-change', (list: unknown) => {
            if (!this.status)
                return;

            this._applyQuickPhrases(Array.isArray(list) ? list.map(String) : []);
        });
    }

    override hide() {
        // 「关卡片」的入口（Esc / 取消 / 点外部 / 编辑器滚动）统一改走动画退场；
        // 退场自身收尾时 `_exiting` 已置位，直达下面的关闭清理，不会绕圈。
        if (this.status && !this._exiting) {
            this._leaveCard(true);
            return;
        }

        this._clearTimers();
        this._cancelEnter();
        this._altTimer = this._cancelTimer(this._altTimer);
        this._setAltOn(false);

        if (this._repositionTimer) {
            clearTimeout(this._repositionTimer);
            this._repositionTimer = null;
        }

        this._snapshot = null;
        this._editing = null;
        // 卡片真正关闭，「正在标注的选区」也不再画（退场动画期间保留，见 _leaveCard）
        this.muya.editor.annotation?.setPendingRanges([]);
        this._range = null;
        this._referenceRect = null;
        this._fallbackRect = null;
        this._phrases = [];
        this._chipEls = [];
        this._quickRow = null;
        this._hintEl = null;
        this._collectButton = null;
        this._hoveredPhrase = null;
        this._hintOverride = null;
        this._bornPhrases.clear();
        this._exiting = false;
        this.floatBox?.classList.remove('is-leaving', 'quick', 'is-pre-enter', 'is-entering', 'is-editing');

        // 焦点还在卡片里（输入框 / 按钮）就交还给编辑器：不交的话用户接着打字会
        // 打进屏幕外的输入框，⌘Z 也会被卡片（已隐藏）的键盘处理吃掉——正文撤销
        // 反而失效。
        if (this.floatBox?.contains(document.activeElement))
            this.muya.focus();

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
        this._clearTimers();
        this._cancelEnter();

        for (const timer of this._relayTimers)
            clearTimeout(timer);
        this._relayTimers.clear();

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

        // 此刻选区还是编辑器里的真实选区（工具条发事件前刚还原过），所以贴边矩形
        // 都从它取。
        const editing = module.findAtSnapshot(snapshot);
        this._snapshot = snapshot;
        this._editing = editing;
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

        // 上一轮退场若还在途，这里直接接管：先清掉它留下的定时器与浮层类。
        this._exiting = false;
        this._clearTimers();
        this._cancelEnter();
        this._phrases = Array.isArray(module.quickPhrases) ? [...module.quickPhrases] : [];
        this._hoveredPhrase = null;
        this._hintOverride = null;
        this._bornPhrases.clear();
        // 上一张卡片可能是在 ⌥ 按住时被关掉的：角标态随卡片一起收走
        this._quickRow?.classList.remove('alt-on');
        this._altOn = false;
        this._altTimer = this._cancelTimer(this._altTimer);

        this._render();

        if (this._note) {
            this._note.value = editing?.note ?? '';
            this._autoGrow();
        }
        this._syncSaveState();
        this._syncCollect();
        this._syncHint();

        // 先把位置量成数值快照，再加 pending 高亮：后者会让块重渲染、换掉 DOM
        // 节点，届时 `_range` 已失效、量出来是 0×0，卡片会贴到屏幕左上角。
        const reference = this._reference();
        this._referenceRect = reference ? reference.getBoundingClientRect() : null;

        // 卡片打开期间把「正在标注的选区」画成选中态（用户拍板）：卡片抢焦点后
        // 原生选区就没了，用户看不出这条备注是给哪段写的。关卡片时清掉。
        module.setPendingRanges(selectionToRanges(snapshot));

        // 闭包捕获快照本身（而不是 this._referenceRect）：floating-ui 是异步量
        // 位置的，等到它回调时卡片可能已关闭、字段已被清成 null。
        const rect = this._referenceRect;
        if (rect)
            this.show({ getBoundingClientRect: () => rect });

        this._focusNote();
        this._runEnter();
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
                'button.mu-annotation-gear',
                {
                    attrs: {
                        'type': 'button',
                        'title': i18n.t('Manage quick phrases…'),
                        'aria-label': i18n.t('Manage quick phrases…'),
                    },
                    props: { innerHTML: GEAR_ICON },
                    on: { click: () => this.muya.eventCenter.emit('muya-annotation-settings') },
                },
            ),
        ]);

        // chips 行：空列表时整体隐身（children 数量恒定，patch 不会错位）
        const quick = h(
            'div.mu-annotation-quick',
            { attrs: { hidden: !this._phrases.length } },
            this._phrases.map((phrase, index) => this._chipVNode(phrase, index)),
        );

        const note = h('textarea.mu-annotation-note', {
            attrs: {
                rows: String(NOTE_MIN_ROWS),
                placeholder: this._hoveredPhrase ?? this._notePlaceholder(),
                spellcheck: 'false',
            },
            on: {
                input: () => {
                    this._autoGrow();
                    this._syncSaveState();
                    this._syncCollect();
                    this._syncHint();
                },
                keydown: (event: Event) => this._handleKeydown(event),
                keyup: (event: Event) => this._handleKeyup(event),
                // 失焦（含切走窗口）时收起 ⌥ 角标：只在 keyup 收的话，按住 ⌥ 直接
                // 切走窗口会一直卡在角标态。
                blur: () => this._setAltOn(false),
            },
        });

        const hint = h(
            'span.mu-annotation-hint',
            HINT_STATES.map(state => h(
                'span.mu-annotation-hint-item',
                {
                    attrs: { 'data-hint': state },
                    class: { on: state === this._hintState() },
                },
                this._hintText(state),
            )),
        );

        const foot = h('div.mu-annotation-foot', [
            hint,
            h(
                'button.mu-annotation-btn.ghost.mu-annotation-collect',
                {
                    attrs: { type: 'button' },
                    on: { click: () => this._collectPhrase() },
                },
                `＋ ${i18n.t('Save as quick phrase')}`,
            ),
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

        const card = h('div.mu-annotation-card', [head, quick, note, foot]);

        if (oldVNode)
            patch(oldVNode, card);
        else
            patch(cardContainer, card);

        this._oldVNode = card;
        this._note = cardContainer.querySelector('textarea.mu-annotation-note');
        this._saveButton = cardContainer.querySelector('button.mu-annotation-btn.primary');
        this._quickRow = cardContainer.querySelector('div.mu-annotation-quick');
        this._hintEl = cardContainer.querySelector('span.mu-annotation-hint');
        this._collectButton = cardContainer.querySelector('button.mu-annotation-collect');
        this._chipEls = [...cardContainer.querySelectorAll<HTMLButtonElement>('button.mu-annotation-quick-chip')];
    }

    /** 一枚常用语 chip：文字 + 墨染裁剪层 + ⌥N 角标（原型 §1.1）。 */
    private _chipVNode(phrase: string, index: number) {
        return h(
            'button.mu-annotation-quick-chip',
            {
                // snabbdom 按 key 复用节点：设置里删掉/拖动中间一条时，不写 key
                // 会按位置复用，DOM 上手动加的 `.stamp`（落印态）会跑到别人身上。
                key: phrase,
                // 入场错峰：70 + 30·i，第 6 枚起封顶 220ms（§3.2 #5）
                style: { '--d': `${Math.min(70 + index * 30, 220)}ms` },
                attrs: { type: 'button', title: phrase },
                class: { born: this._bornPhrases.has(phrase) },
                on: {
                    // chip 在 mousedown 上 preventDefault：输入框不失焦、焦点环不闪
                    mousedown: (event: Event) => event.preventDefault(),
                    click: (event: Event) => {
                        event.preventDefault();
                        this._clickChip(phrase, isMouseEvent(event)
                            ? { x: event.clientX, y: event.clientY }
                            : undefined);
                    },
                    mouseenter: () => this._previewPhrase(phrase),
                    mouseleave: () => this._clearPreview(),
                },
            },
            [
                h('span.mu-annotation-quick-text', phrase),
                h('span.mu-annotation-quick-fill'),
                h('span.mu-annotation-quick-key', `⌥${index + 1}`),
            ],
        );
    }

    /**
     * 点 chip = 以该短语为备注直接完成标注（v7 定案）：先落印 + 墨染，100ms 后
     * 走保存编排。用户自己写的字由 `composeNote` 并进去，一个字不丢。
     */
    private _clickChip(phrase: string, point?: { x: number; y: number }) {
        // 退场在途时不再受理（`_save` 里也有同样的守卫，这里挡住「连点两枚
        // chip、第二个定时器晚于退场起点」的重复落标）
        if (this._exiting)
            return;

        const index = this._phrases.indexOf(phrase);
        const chip = index >= 0 ? this._chipEls[index] : null;

        if (chip) {
            chip.classList.add('stamp');
            // 落印 / 墨染的摘除用裸定时器：卡片即使已经在收场，这两记反馈也要播完
            setTimeout(() => chip.classList.remove('stamp'), STAMP_DURATION);
            this._playInk(chip, point);
        }

        this._chipSaveTimer = this._cancelTimer(this._chipSaveTimer);
        this._chipSaveTimer = this._setTimeout(() => {
            this._chipSaveTimer = null;
            this._save(phrase);
        }, CHIP_SAVE_DELAY);
    }

    /** 墨染：以点击点为圆心的 accent 圆，scale 0 → 1（§3.2 #12）。 */
    private _playInk(chip: HTMLElement, point?: { x: number; y: number }) {
        const fill = chip.querySelector('.mu-annotation-quick-fill') ?? chip;
        const rect = chip.getBoundingClientRect();
        const x = (point ? point.x : rect.left + rect.width / 2) - rect.left;
        const y = (point ? point.y : rect.top + rect.height / 2) - rect.top;
        // 半径取「点击点到最远角」的两倍直径，保证圆能盖满整枚胶囊
        const diameter = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y)) * 2;

        const ink = document.createElement('span');
        ink.className = 'mu-annotation-quick-ink';
        ink.style.setProperty('--ix', `${x}px`);
        ink.style.setProperty('--iy', `${y}px`);
        ink.style.setProperty('--id', `${diameter}px`);
        fill.appendChild(ink);

        requestAnimationFrame(() => ink.classList.add('run'));
        setTimeout(() => ink.remove(), INK_DURATION);
    }

    /** 保存并收场：编辑态改备注，新建态落一条新标注。`phrase` 非空 = chip 路径。 */
    private _save(phrase?: string) {
        // 退场窗口内（快照已摘、卡片正在消失）不再接受任何提交：`_snapshot` 的
        // 判空之外再加一道，挡住 chip 定时器与键盘这两条仍在途的路径。
        if (this._exiting)
            return;

        const noteValue = this._note?.value ?? '';
        const module = this._annotationModule();
        const { _snapshot: snapshot, _editing: editing } = this;
        if (!snapshot || !module)
            return;

        const note = phrase ? composeNote(noteValue, phrase) : noteValue.trim();
        if (!note)
            return;

        let saved: IAnnotation | null = null;

        if (editing) {
            // 编辑态的条目可能已经在面板里被删掉了：`updateNote` 返回 false 时不能
            // 当成保存成功——否则卡片收场、飞点照播，用户刚写的字静默消失。
            if (!module.updateNote(editing.id, note)) {
                this._flashSaveFailed();
                return;
            }
        }
        else {
            saved = module.addFromSnapshot(snapshot, note);
            // 空选区 / 锚点提取失败（一期不画高亮的块）会返回 null——同样不退场、
            // 不播动效，把失败亮在底栏，输入框里的字保留给用户重试或复制。
            if (!saved) {
                this._flashSaveFailed();
                return;
            }
        }

        // 飞点起点先取：卡片紧接着开始退场，但退出动画是异步的，此刻矩形还是准的。
        const origin = this._saveOrigin(phrase);
        const payload: IAnnotationSavedPayload = { origin, mode: phrase ? 'chip' : 'manual' };

        this.muya.eventCenter.emit('muya-annotation-saved', payload);
        this._leaveCard(false);

        // §3.2 #20 正文高亮接力：新建成功的条目亮一记，把「落在哪」指给用户
        if (saved)
            this._scheduleRelay(saved.id);
    }

    /**
     * 保存后的正文高亮接力（§3.2 #20）：给刚落下的高亮 span 挂一次性 class，
     * 背景 0 → 22% → 14% 亮一记。DOM 上的高亮只带序号（不带 id），所以按文档
     * 顺序反查刚保存条目的序号。
     */
    private _scheduleRelay(id: string) {
        const timer = setTimeout(() => {
            this._relayTimers.delete(timer);

            const module = this._annotationModule();
            if (!module)
                return;

            const ordered = module.list().filter(item => !item.archived);
            const index = ordered.findIndex(item => item.id === id) + 1;
            if (!index)
                return;

            // 限定在本编辑器内查询：分屏时第二个 Muya 实例的正文里会有同序号
            // 的高亮，全局查询会把别人的 span 也点亮。
            const root: ParentNode = this.muya.domNode ?? document;
            const spans = root.querySelectorAll<HTMLElement>(
                `.mu-annotation[data-index="${index}"], .mu-annotation-active[data-index="${index}"]`,
            );
            spans.forEach((span) => {
                span.classList.add('mu-annotation-relay');
                setTimeout(() => span.classList.remove('mu-annotation-relay'), RELAY_DURATION);
            });
        }, RELAY_DELAY);

        this._relayTimers.add(timer);
    }

    /**
     * 飞点起点（供桌面动画）：chip 路径取那枚胶囊的中心（用户刚点的就是它），
     * 手写路径取保存按钮中心（缺按钮时退到卡片中心）。
     */
    private _saveOrigin(phrase?: string): { x: number; y: number } | null {
        let el: HTMLElement | null = null;

        if (phrase) {
            const index = this._phrases.indexOf(phrase);
            el = (index >= 0 ? this._chipEls[index] : null) ?? null;
        }

        el = el ?? this._saveButton ?? this.floatBox;
        if (!el)
            return null;

        const rect = el.getBoundingClientRect();
        if (!rect.width && !rect.height)
            return null;

        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    /**
     * 卡片退场（§3.2 #18/#19）：保存走 150ms、取消 / Esc / 点外部走 110ms 的
     * 收场动画，动画结束后 BaseFloat 才真正隐藏。
     */
    private _leaveCard(quick: boolean) {
        if (!this.status || this._exiting)
            return;

        this._exiting = true;
        this._cancelEnter();

        // 退场这 110–150ms 里卡片必须"已经结束"：清掉待触发的 chip 保存、让输入框
        // 失焦、把快照摘掉。否则再按一次 ⌘↵ / ⌥N 会拿同一份快照再落一条（重复
        // 标注）；切文档 / 重载的窗口里还会把旧快照落到新文档上。
        this._chipSaveTimer = this._cancelTimer(this._chipSaveTimer);
        this._snapshot = null;
        this._editing = null;
        this._hoveredPhrase = null;
        if (this._note && document.activeElement === this._note)
            this._note.blur();

        if (this._repositionTimer) {
            clearTimeout(this._repositionTimer);
            this._repositionTimer = null;
        }

        const { floatBox } = this;
        if (floatBox) {
            floatBox.classList.remove('is-pre-enter', 'is-entering');
            floatBox.classList.toggle('quick', quick);
        }

        this.leave();
    }

    /**
     * 入场（§3.2 #1–#8）：先 `.is-pre-enter` 压一帧，再 `.is-entering` 播
     * opacity / scale / translate 三条独立动画；方向按卡片最终落在选区的上/下方
     * 写进 `data-side`，内容分层错峰在 CSS 里。
     */
    private _runEnter() {
        const { floatBox } = this;
        if (!floatBox)
            return;

        floatBox.classList.remove('is-leaving', 'quick', 'is-entering');
        // 编辑态：内容整体淡入、不逐项错峰（#8）
        floatBox.classList.toggle('is-editing', !!this._editing);
        floatBox.classList.add('is-pre-enter');

        let frames = 0;
        const tick = () => {
            this._enterRaf = null;
            if (!this.status || this._exiting || !this.floatBox)
                return;

            // 等 BaseFloat 把位置与 opacity 写上的那一帧：flip 之后才知道卡片落在
            // 上方还是下方，抢跑会把卡片从错的方向推进来。等不到就走默认方向，
            // 但走 —— 不能让 `.is-pre-enter` 把卡片一直压在隐身态。
            if (floatBox.style.opacity !== '1' && frames < ENTER_MAX_FRAMES) {
                frames += 1;
                this._enterRaf = requestAnimationFrame(tick);
                return;
            }

            floatBox.setAttribute('data-side', this._sideOf());
            floatBox.classList.remove('is-pre-enter');
            floatBox.classList.add('is-entering');
            this._setTimeout(() => floatBox.classList.remove('is-entering'), ENTER_DURATION);
        };

        this._enterRaf = requestAnimationFrame(tick);
    }

    private _cancelEnter() {
        if (this._enterRaf !== null) {
            cancelAnimationFrame(this._enterRaf);
            this._enterRaf = null;
        }
    }

    /** 卡片最终落在选区的上方还是下方（flip 由 floating-ui 倒，这里量最终落位）。 */
    private _sideOf(): 'above' | 'below' {
        const boxRect = this.floatBox?.getBoundingClientRect();
        const refRect = this._reference()?.getBoundingClientRect();

        if (!boxRect || !refRect || !boxRect.height)
            return 'below';

        return boxRect.top + boxRect.height / 2 <= refRect.top + refRect.height / 2
            ? 'above'
            : 'below';
    }

    private _handleKeydown(event: Event) {
        if (!isKeyboardEvent(event))
            return;

        // 退场在途：Esc / ⌘↵ 都不再受理（快照已摘，提交也只会被 `_save` 丢掉）
        if (this._exiting)
            return;

        if (event.key === EVENT_KEYS.Escape) {
            event.preventDefault();
            this.hide();
            return;
        }

        // §1.4 卡片自己拦截 ⌘Z / ⌘⇧Z：只撤销输入框内容，不误撤正文
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            event.stopPropagation();
            document.execCommand(event.shiftKey ? 'redo' : 'undo');
            return;
        }

        // ⌥ 按住 120ms → chips 浮出数字角标（#26）
        if (event.key === 'Alt' && !event.repeat) {
            this._scheduleAltReveal();
            return;
        }

        // 输入法候选框里的数字键不能被抢（§1.4）
        if (event.isComposing || event.keyCode === 229)
            return;

        // 输入框为空时 ⌘↵ 没有备注可存 —— 让它走主路径：用第 1 枚常用语直接落标
        if (event.key === EVENT_KEYS.Enter && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!this._note?.value.trim()) {
                const first = this._phrases[0];
                if (first)
                    this._clickChip(first);
                return;
            }
            this._save();
            return;
        }

        this._triggerChipByDigit(event);
    }

    private _scheduleAltReveal() {
        this._altTimer = this._cancelTimer(this._altTimer);
        this._altTimer = this._setTimeout(() => this._setAltOn(true), ALT_REVEAL_DELAY);
    }

    /** ⌥N 等价于点第 N 枚 chip（#26）：preventDefault 顺手挡掉 ¡™£ 之类字符。 */
    private _triggerChipByDigit(event: KeyboardEvent) {
        const digit = /^Digit([1-9])$/.exec(event.code ?? '');
        if (!digit || !event.altKey)
            return;

        const phrase = this._phrases[Number(digit[1]) - 1];
        if (!phrase)
            return;

        event.preventDefault();
        event.stopPropagation();
        this._clickChip(phrase);
    }

    private _handleKeyup(event: Event) {
        if (!isKeyboardEvent(event) || event.key !== 'Alt')
            return;

        this._altTimer = this._cancelTimer(this._altTimer);
        this._setAltOn(false);
    }

    /** ⌥ 角标态：容器加 `.alt-on`，底栏提示随之切换。 */
    private _setAltOn(on: boolean) {
        if (this._altOn === on)
            return;

        this._altOn = on;
        this._quickRow?.classList.toggle('alt-on', on);
        this._syncHint();
    }

    /** hover 预演：输入框为空时 placeholder 临时换成该短语（选一句看看）。 */
    private _previewPhrase(phrase: string) {
        this._hoveredPhrase = phrase;
        this._syncHint();

        const { _note: note } = this;
        if (note && !note.value.trim())
            note.placeholder = phrase;
    }

    private _clearPreview() {
        if (!this._hoveredPhrase)
            return;

        this._hoveredPhrase = null;
        if (this._note)
            this._note.placeholder = this._notePlaceholder();
        this._syncHint();
    }

    private _notePlaceholder(): string {
        return this.muya.i18n.t('Write a note, e.g. this logic is wrong');
    }

    /** 底栏情境提示的当前态（#25）：临时覆盖 > 悬停 > ⌥ > 手写 > 默认。 */
    private _hintState(): THintState {
        if (this._hintOverride)
            return this._hintOverride;
        if (this._hoveredPhrase)
            return 'hover';
        if (this._altOn && this._phrases.length)
            return 'alt';

        return this._note?.value.trim() ? 'typed' : 'default';
    }

    private _hintText(state: THintState): string {
        const { i18n } = this.muya;

        switch (state) {
            case 'default':
                // 一条常用语都没有时不能还说「点常用语」——那时根本没有 chip 可点
                return this._phrases.length
                    ? i18n.t('Click a phrase to annotate, or write your own')
                    : i18n.t('Write a note of your own');
            case 'hover':
                return i18n.t('Click to save with this phrase as the note');
            case 'alt': {
                // 只有一条时退化成「⌥1 直接标注」
                const keys = this._phrases.length > 1 ? `⌥1–⌥${this._phrases.length}` : '⌥1';
                return `${keys} ${i18n.t('to annotate directly')}`;
            }
            case 'saved':
                // 实际序号在闪示时写进文本（`_flashHint`），这里给个安全的初值
                return `${i18n.t('Added')} · ⌥${this._phrases.length}`;
            case 'failed':
                return i18n.t('Could not save, try again');
            case 'typed':
                return `Esc ${i18n.t('Cancel')} · ${COMMAND_KEY}↵ ${i18n.t('Save')}`;
        }
    }

    private _syncHint() {
        const { _hintEl: hint } = this;
        // 提示位让给「＋ 存为常用语」时它是 hidden 的，不用刷
        if (!hint || hint.hidden)
            return;

        const state = this._hintState();
        hint.querySelectorAll<HTMLElement>('[data-hint]').forEach((el) => {
            el.classList.toggle('on', el.dataset.hint === state);
        });
    }

    /** 底栏提示位二选一：情境提示，或「＋ 存为常用语」（§1.5）。 */
    private _syncCollect() {
        const phrase = collectablePhrase(
            this._note?.value ?? '',
            this._phrases,
            QUICK_PHRASE_MAX_LEN,
            QUICK_PHRASE_MAX_COUNT,
        );

        if (this._collectButton)
            this._collectButton.hidden = !phrase;
        if (this._hintEl)
            this._hintEl.hidden = !!phrase;

        this._syncHint();
    }

    /** 「＋ 存为常用语」：写进偏好（桌面负责落盘），提示位就地播「已加入 · ⌥N」。 */
    private _collectPhrase() {
        const phrase = collectablePhrase(
            this._note?.value ?? '',
            this._phrases,
            QUICK_PHRASE_MAX_LEN,
            QUICK_PHRASE_MAX_COUNT,
        );
        if (!phrase)
            return;

        const payload: IAnnotationPhraseAddPayload = { phrase };
        this.muya.eventCenter.emit('muya-annotation-phrase-add', payload);

        // 乐观切回提示位：桌面写盘后才会回 `annotation-quick-phrases-change`，
        // 本地先把「＋ 存为常用语」收掉，别让提示等一个来回
        if (this._collectButton)
            this._collectButton.hidden = true;
        if (this._hintEl)
            this._hintEl.hidden = false;

        this._flashHint(`⌥${this._phrases.length + 1}`);
    }

    /** 底栏提示的临时覆盖（「已加入 · ⌥N」）：1.6s 后回落到情境态。 */
    private _flashHint(label: string) {
        const { _hintEl: hint } = this;
        const saved = hint?.querySelector<HTMLElement>('[data-hint="saved"]');
        if (!hint || hint.hidden || !saved)
            return;

        saved.textContent = `${this.muya.i18n.t('Added')} · ${label}`;
        this._hintOverride = 'saved';
        this._syncHint();
        this._setTimeout(() => {
            this._hintOverride = null;
            // 重算提示位：桌面若没真的收下这条（写盘失败 / 去重），把「＋ 存为常用语」放回来
            this._syncCollect();
        }, HINT_FLASH_DURATION);
    }

    /** 保存失败（条目已被删 / 锚点提取失败）：不退场，底栏亮一句失败提示后回落。 */
    private _flashSaveFailed() {
        const { _hintEl: hint } = this;
        // 提示位正让给「＋ 存为常用语」时失败提示无处可放——先把它收掉，失败更要紧
        if (this._collectButton)
            this._collectButton.hidden = true;
        if (hint)
            hint.hidden = false;

        this._hintOverride = 'failed';
        this._syncHint();
        this._failHintTimer = this._cancelTimer(this._failHintTimer);
        this._failHintTimer = this._setTimeout(() => {
            this._failHintTimer = null;
            this._hintOverride = null;
            // 回落时重算提示位：该出现的「＋ 存为常用语」要放回来
            this._syncCollect();
        }, FAILED_HINT_DURATION);
    }

    /** 常用语整表刷新（桌面偏好变化）：新增的 chip 播出生动画，提示位与键位重算。 */
    private _applyQuickPhrases(list: string[]) {
        const previous = this._phrases;
        const born = list.filter(phrase => !previous.includes(phrase));

        this._phrases = [...list];
        if (this._hoveredPhrase && !this._phrases.includes(this._hoveredPhrase))
            this._clearPreview();

        if (born.length) {
            born.forEach(phrase => this._bornPhrases.add(phrase));
            // born 只是出生动画的触发类：摘除走裸定时器，卡片收起了也要摘
            setTimeout(() => {
                born.forEach(phrase => this._bornPhrases.delete(phrase));
            }, BORN_DURATION);
        }

        // 重画整个卡片：textarea 是原地 patch（同样的 sel / 位置），内容与焦点不丢
        this._render();
        this._syncSaveState();
        this._syncCollect();
    }

    /** 空备注不允许保存（方案 §3.6「空备注」）。 */
    private _syncSaveState() {
        if (this._saveButton)
            this._saveButton.disabled = !this._note?.value.trim();
    }

    /** 文本框高度随内容增长，3 行起、10 行封顶，超出改为内部滚动。 */
    private _autoGrow() {
        const { _note: note } = this;
        if (!note)
            return;

        // 行高优先读计算样式（CSS 改了字号也不会算歪）；无单位值（`line-height: 1.6`
        // 在未布局环境里会原样返回 "1.6"）与拿不到值时退回常量。
        const cs = getComputedStyle(note);
        const computed = Number.parseFloat(cs.lineHeight);
        const lineHeight = Number.isFinite(computed) && computed >= MIN_LINE_HEIGHT
            ? computed
            : NOTE_LINE_HEIGHT;
        // 高度按 border-box 写：上下 padding 与边框不占内容区，min/max 必须把它们
        // 加回去，否则「10 行封顶」实际在 9 行出头就冒出滚动条。
        const chrome
            = (Number.parseFloat(cs.paddingTop) || 0)
                + (Number.parseFloat(cs.paddingBottom) || 0)
                + (Number.parseFloat(cs.borderTopWidth) || 0)
                + (Number.parseFloat(cs.borderBottomWidth) || 0);
        const min = lineHeight * NOTE_MIN_ROWS + chrome;
        const max = lineHeight * NOTE_MAX_ROWS + chrome;

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

    /** 卡片贴边参照：打开瞬间的数值快照（见 `_referenceRect`），退化时才现量。 */
    private _reference(): ReferenceElement | null {
        const rect = this._referenceRect;
        if (rect)
            return { getBoundingClientRect: () => rect };

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
                const rects = [...range.getClientRects()].filter(r => r.width > 0);
                return rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
            },
        };
    }

    private _scheduleReposition() {
        if (this._repositionTimer)
            clearTimeout(this._repositionTimer);

        this._repositionTimer = setTimeout(() => {
            this._repositionTimer = null;
            if (!this.status || this._exiting || !this.floatBox)
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

    /** 托管式 setTimeout：hide / destroy 时统一清掉，避免卡片关了还回调。 */
    private _setTimeout(fn: () => void, ms: number) {
        const timer = setTimeout(() => {
            this._timers.delete(timer);
            fn();
        }, ms);

        this._timers.add(timer);

        return timer;
    }

    /** 撤掉一枚托管定时器（提前触发路径用）。 */
    private _cancelTimer(timer: ReturnType<typeof setTimeout> | null) {
        if (!timer)
            return null;

        clearTimeout(timer);
        this._timers.delete(timer);

        return null;
    }

    private _clearTimers() {
        for (const timer of this._timers)
            clearTimeout(timer);

        this._timers.clear();
    }

    private _cloneLiveRange(): Range | null {
        const selection = document.getSelection();
        if (!selection || !selection.rangeCount)
            return null;

        return selection.getRangeAt(0).cloneRange();
    }
}

export default AnnotationTool;
