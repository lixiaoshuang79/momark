import type { Placement, ReferenceElement } from '@floating-ui/dom';
import type { Muya } from '../../index';
import type { IBaseOptions } from '../types';
import { autoUpdate, computePosition, flip, offset } from '@floating-ui/dom';
import { EVENT_KEYS } from '../../config';

import { isHTMLElement, isKeyboardEvent, noop } from '../../utils';
import { findScrollContainer } from '../../utils/dom';

import './index.css';

function defaultOptions() {
    return {
        placement: 'bottom-start' as Placement,
        offsetOptions: {
            mainAxis: 10,
            crossAxis: 0,
            alignmentAxis: 0,
        },
        showArrow: false,
    };
}

const BUTTON_GROUP = ['mu-table-drag-bar', 'mu-front-button'];

/**
 * `leave()` 的兜底时长（ms）。退场动画由各浮层自己用 `.is-leaving` 写，
 * 这里只保证「动画没播完 / 根本没动画」时卡片也会按时收场。
 */
const LEAVE_FALLBACK = 220;

abstract class BaseFloat {
    protected options: IBaseOptions;
    public status: boolean = false;
    public capturesContentKeydown = false;
    public floatBox: HTMLElement | null = null;
    public container: HTMLElement | null = null;
    private _lastScrollTop: number | null = null;
    protected cb: (...args: unknown[]) => void = noop;

    private _cleanup: (() => void) | null = null;
    private _resizeObserver: ResizeObserver | null = null;
    /** 退场在途标记（非空 = 正在 leave，同时也是兜底定时器句柄）。 */
    private _leaveTimer: ReturnType<typeof setTimeout> | null = null;
    private _leaveHandler: ((event: Event) => void) | null = null;

    constructor(
        public muya: Muya,
        public name: string,
        options = {},
    ) {
        this.options = Object.assign({}, defaultOptions(), options);
        this.init();
    }

    init() {
        const floatBox = document.createElement('div');
        const container = document.createElement('div');
        // Use to remember which float container is shown.
        container.classList.add(this.name);
        container.classList.add('mu-float-container');
        floatBox.classList.add('mu-float-wrapper');

        floatBox.appendChild(container);
        document.body.appendChild(floatBox);

        this.floatBox = floatBox;
        this.container = container;

        // Since the size of the container is not fixed and changes according to the change of content,
        // the floatBox needs to set the size according to the container size
        const resizeObserver = (this._resizeObserver = new ResizeObserver(() => {
            // Use requestAnimationFrame to avoid "ResizeObserver loop completed" warning
            requestAnimationFrame(() => {
                const { offsetWidth, offsetHeight } = container;

                Object.assign(floatBox.style, {
                    width: `${offsetWidth}px`,
                    height: `${offsetHeight}px`,
                });
            });
        }));

        resizeObserver.observe(container);
    }

    listen() {
        const { eventCenter, domNode } = this.muya;
        const { floatBox } = this;

        const keydownHandler = (event: Event) => {
            if (isKeyboardEvent(event) && event.key === EVENT_KEYS.Escape)
                this.hide();
        };

        /**
         * After the editor scrolls vertically beyond a certain range,
         * it means that the user's focus is no longer on the float box,
         * so the float box needs to be hidden.
         */
        const scrollHandler = (event: Event) => {
            if (!isHTMLElement(event.target))
                return;
            if (typeof this._lastScrollTop !== 'number') {
                this._lastScrollTop = event.target.scrollTop;

                return;
            }

            // only when scroll distance great than 50px, then hide the float box.
            if (
                this.status
                && Math.abs(event.target.scrollTop - this._lastScrollTop) > 50
            ) {
                this.hide();
            }
        };

        eventCenter.attachDOMEvent(document, 'click', this.hide.bind(this));
        eventCenter.attachDOMEvent(floatBox!, 'click', (event) => {
            event.stopPropagation();
            event.preventDefault();
        });
        eventCenter.attachDOMEvent(domNode, 'keydown', keydownHandler);
        eventCenter.attachDOMEvent(findScrollContainer(domNode), 'scroll', scrollHandler);
    }

    hide() {
        if (!this.status)
            return;

        this._cancelLeave();

        const { eventCenter } = this.muya;
        const { floatBox } = this;
        this.status = false;

        if (this._cleanup) {
            this._cleanup();
            this._cleanup = null;
        }

        if (floatBox) {
            Object.assign(floatBox.style, {
                opacity: 0,
                top: '-9999px',
                left: '-9999px',
            });
        }

        this.cb = noop;
        this._lastScrollTop = null;

        if (BUTTON_GROUP.includes(this.name))
            eventCenter.emit('muya-float-button', this, false);
        else eventCenter.emit('muya-float', this, false);
    }

    /**
     * 可选退场：给浮层加 `.is-leaving`（样式由各浮层在 CSS 里写：退场动画 +
     * `pointer-events: none`），等退场动画播完、或 220ms 兜底后再真正 `hide()`。
     * 没有写 `.is-leaving` 动画的浮层行为与直接 `hide()` 一致（只是晚一帧多）。
     *
     * 离场途中再次 `show()` 会取消退场（`show()` 里已处理）；`destroy()` 会清掉
     * 未决的定时器与监听。
     */
    leave() {
        const { floatBox } = this;
        if (!this.status || this._leaveTimer || !floatBox)
            return;

        floatBox.classList.add('is-leaving');
        floatBox.style.pointerEvents = 'none';

        const finish = () => {
            this._cancelLeave();
            this.hide();
        };

        // 只认落在浮层本体上的 animationend：子元素的瞬态动画（墨染、落印）
        // 也会冒泡到这里，若照单全收，收场会在半途被提前结束。
        this._leaveHandler = (event: Event) => {
            if (event.target === floatBox)
                finish();
        };
        floatBox.addEventListener('animationend', this._leaveHandler);
        this._leaveTimer = setTimeout(finish, LEAVE_FALLBACK);
    }

    /** 取消未决的退场并把浮层恢复成「可交互」状态（幂等）。 */
    private _cancelLeave() {
        const { floatBox } = this;

        if (this._leaveTimer) {
            clearTimeout(this._leaveTimer);
            this._leaveTimer = null;
        }
        if (this._leaveHandler && floatBox) {
            floatBox.removeEventListener('animationend', this._leaveHandler);
            this._leaveHandler = null;
            floatBox.classList.remove('is-leaving');
            floatBox.style.pointerEvents = '';
        }
    }

    // `cb` is a generic "selection made" callback. Concrete floats invoke it
    // with their own argument tuple (e.g. emojiSelector → `(item)`,
    // tableChessboard → `(row, column)`). `never[]` in the contravariant
    // arg position accepts any concrete callback shape.
    show(reference: ReferenceElement, cb: (...args: never[]) => void = noop) {
        const { floatBox } = this;
        const { eventCenter } = this.muya;
        const { placement, offsetOptions } = this.options;
        if (!floatBox) {
            throw new Error('The float box is not existed.');
        }
        // 上一轮退场还没播完就重新显示：取消退场，免得兜底定时器稍后把它拽黑。
        this._cancelLeave();
        if (this._cleanup) {
            this._cleanup();
            this._cleanup = null;
        }

        // `cb` is declared with `never[]` args at the parameter so any
        // concrete callback shape is accepted; the field stores it as
        // `unknown[]` so internal call sites can forward arbitrary args.
        this.cb = cb as (...args: unknown[]) => void;

        const cleanup = autoUpdate(reference, floatBox, () => {
            computePosition(reference, floatBox, {
                placement,
                middleware: [offset(offsetOptions), flip()],
            }).then(({ x, y }) => {
                // `computePosition` is async: a `hide()` (or a newer `show()`)
                // can land before this resolves. Applying it then would set
                // `opacity: 1` on an already-hidden float without restoring
                // `status`, so the next `hide()` early-returns and the float is
                // stuck visible. Bail unless this pass is still the active one.
                if (this._cleanup !== cleanup)
                    return;
                Object.assign(floatBox.style, {
                    left: `${x}px`,
                    top: `${y}px`,
                    opacity: 1,
                });
            });
        });
        this._cleanup = cleanup;

        this.status = true;

        if (BUTTON_GROUP.includes(this.name))
            eventCenter.emit('muya-float-button', this, true);
        else eventCenter.emit('muya-float', this, true);
    }

    destroy() {
        this._cancelLeave();

        if (this.container && this._resizeObserver)
            this._resizeObserver.unobserve(this.container);

        if (this._cleanup) {
            this._cleanup();
            this._cleanup = null;
        }

        this.floatBox?.remove();
    }
}

export default BaseFloat;
