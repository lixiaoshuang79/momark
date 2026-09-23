import type { Muya } from '../../../muya';
import type { IHtmlBlockState, IHtmlFrameMeta, TState } from '../../../state/types';
import type { Nullable } from '../../../types';
import { CLASS_NAMES, PREVIEW_DOMPURIFY_CONFIG } from '../../../config';
import { sanitize } from '../../../utils';
import { rememberFrameSource } from '../../../utils/htmlFrameSource';
import { getIframeSrc, getImageSrc } from '../../../utils/image';
import logger from '../../../utils/logger';
import Parent from '../../base/parent';
import HTMLBlock from './index';

const debug = logger('htmlPreview:');

/**
 * 外框（`.mu-html-frame`）与外界的契约：初始尺寸来自块状态，用户改完尺寸再写回块状态。
 * 外壳只认这两个数据，不 import 块实现（`htmlFrameSource` 注释里那条引用链约束）。
 */
interface IFrameShellContext {
    /** 块状态里存的外框尺寸（老文档没有 → undefined，外壳行为与历史版本一致） */
    meta?: IHtmlFrameMeta;
    /** 用户交互结束时回调一次；不传表示该调用方不需要落盘（例如离屏导出） */
    onCommit?: (meta: IHtmlFrameMeta) => void;
}

// Elements whose rendered content comes from attributes (e.g. `src`) rather
// than child nodes, so an empty tag body must not be treated as an empty block.
const SELF_CONTAINED_MEDIA = new Set(['video', 'audio']);

// A single element with an empty body (`<div></div>`), except self-contained
// media elements whose content lives in attributes (`<video src=...></video>`).
export function isEmptyHtmlBlock(html: string): boolean {
    // eslint-disable-next-line regexp/no-super-linear-backtracking, regexp/optimal-quantifier-concatenation
    const match = html.trim().match(/^<([a-z][a-z\d]*)[^>]*>\s*<\/\1>$/);
    return !!match && !SELF_CONTAINED_MEDIA.has(match[1]);
}

export interface IIframeAttrs {
    src: string;
    style: string;
    width: string;
    height: string;
    title: string;
}

const FRAME_SLOT_PREFIX = '@@MU_FRAME_';
// `<iframe ...>` with an optional closing tag and fallback content. Fallback
// content is dropped: the embed either renders or disappears, it never leaks
// escaped source into the preview.

const IFRAME_TAG_REG = /<iframe\b[^>]*>[\s\S]*?<\/iframe>|<iframe\b[^>]*>/gi;

// Replace every `<iframe>` in the raw block source with an inert text slot
// (`<span>@@MU_FRAME_0@@</span>`) so sanitization cannot touch it, and collect
// the whitelisted attributes for later restoration.
export function extractIframeSlots(html: string, frames: Map<string, IIframeAttrs>): string {
    let index = 0;

    return html.replace(IFRAME_TAG_REG, (tag) => {
        const doc = new DOMParser().parseFromString(tag, 'text/html');
        const el = doc.querySelector('iframe');

        if (!el)
            return '';

        const src = el.getAttribute('src');

        if (!src)
            return '';

        const slot = `${FRAME_SLOT_PREFIX}${index++}@@`;
        frames.set(slot, {
            src,
            style: el.getAttribute('style') ?? '',
            width: el.getAttribute('width') ?? '',
            height: el.getAttribute('height') ?? '',
            title: el.getAttribute('title') ?? '',
        });

        return `<span>${slot}</span>`;
    });
}

function findFrameSlot(root: HTMLElement, slot: string): HTMLSpanElement | null {
    const spans = root.querySelectorAll('span');

    for (const span of spans) {
        if (span.textContent === slot)
            return span as HTMLSpanElement;
    }

    return null;
}

// Zoom range for embedded HTML (viewport-size scaling, like a browser
// window; the page reflows so charts redraw to fit).
const FRAME_ZOOM_MIN = 0.5;
const FRAME_ZOOM_MAX = 2;
const FRAME_ZOOM_STEP = 0.1;
// Minimum viewport for dragging, and default height when the author did not
// specify one (the HTML default of 150px is useless for charts/prototypes).
const FRAME_MIN_WIDTH = 240;
const FRAME_MIN_HEIGHT = 160;
const FRAME_DEFAULT_HEIGHT = 400;

// 自适配高度改动 frame 尺寸时广播，让外壳重读自己的尺寸基线：否则用户在自适配
// 生效前拖拽/缩放，会以旧的 400px 基线锚定，一动手就跳一下。
const FRAME_HEIGHT_EVENT = 'mu-html-frame-height-change';

// ── 块内含脚本的 HTML（单文件交互原型/图表）──────────────────────────────
// 无脚本的 HTML 块直接进编辑器 DOM，并经过 DOMPurify 净化 —— `<script>` 会被
// 剥掉，所以「脚本画出来的图」在纯 HTML 块里永远不出现。此前唯一的替代通道是
// `<iframe src="chart.html">`，但那要求把 html 文件一起发出、或者指向联网资源，
// 单个 .md 文件带不动。
//
// 因此：块内出现 `<script>` 时，整个块改在沙箱 iframe 里渲染，源码原样投递给
// 一个随应用打包的 file:// 引导页（见 SCRIPT_FRAME_PAGE），由它 document.write
// 重新解析并执行脚本。**不能**用 `srcdoc`：`srcdoc`/`about:blank`/`blob:` 这类
// 本地文档会继承渲染层的 CSP（`script-src 'self'`），内联脚本被静默拦掉 ——
// 实测帧渲染出来了、脚本却没跑。`file:` 文档不继承，所以脚本能跑。
//
// 安全靠沙箱而不是净化：`allow-scripts` 不带 `allow-same-origin`，作者脚本跑在
// 不透明源里，既碰不到编辑器/文档，也读不到本地文件 —— 与外部 iframe 嵌入（见上）
// 同一套模型，也正是 Typora 的模型。作者源码本来就在 .md 里
// （`_serializeHtmlBlock` 原样写回），所以一个文件发给别人、离线打开照样能跑。
const SCRIPT_TAG_REG = /<script[\s>/]/i;

export function hasInlineScript(html: string): boolean {
    return SCRIPT_TAG_REG.test(html);
}

// 引导页文件名（随渲染层打包，与 index.html 同级）。用相对 URL 解析，因此 dev
// （Vite 服务器）与打包（file:// out/renderer/）两种形态都成立。
const SCRIPT_FRAME_PAGE = 'html-frame.html';

export function scriptFramePageUrl(): string {
    return new URL(SCRIPT_FRAME_PAGE, document.baseURI).href;
}

// 父页面 → 引导页的源码投递消息（协议另一端在 src/renderer/public/html-frame.html）。
export interface IFrameSourceMessage {
    type: 'momark-html-frame-source';
    html: string;
}

export function buildFrameSourceMessage(html: string): IFrameSourceMessage {
    return { type: 'momark-html-frame-source', html };
}

// Wrap the restored iframe in a shell that adds two viewport controls:
// a hover zoom toolbar (− / +, percentage click resets to 100%) and a
// bottom-right drag handle that resizes the frame (the embedded page gets a
// real, different viewport and reflows).
//
// 尺寸自 2026-09 起**落盘**：块的 `state.meta`（markdown 里 `<!--momark-frame
// w=960 h=436 z=1-->` 那行注释）既作为初始值读回来（打开文档即恢复用户上次调好的
// 大小），也在用户交互**结束**时写回去（拖拽抬手 / 点缩放按钮各写一次 —— 拖拽过程
// 每帧都写会与文档状态逐帧对账，界面会闪）。
// 一个外壳的生命周期（基线测量 → 缩放/拖拽交互 → 复位 → 尺寸落盘）必须共享同一组
// 闭包状态（curW/baseW/frameLoaded…）；拆开会把它们全提升成文件级变量，反而更难
// 保证一致性，因此这里放宽函数长度上限。
// eslint-disable-next-line max-lines-per-function
function createFrameShell(frame: HTMLIFrameElement, context: IFrameShellContext): HTMLDivElement {
    const shell = document.createElement('div');
    shell.classList.add(CLASS_NAMES.MU_HTML_FRAME);
    // The author's inline style (e.g. `width:100%;height:400px`) is
    // preserved verbatim: return to it when the user resets to 100%.
    const authorStyle = frame.getAttribute('style') ?? '';
    // The outer block container (`figure.mu-html-block`) must track the
    // viewport too: otherwise a shrunk frame leaves a grey container-width
    // gutter on the right. Resolved lazily — during the first update() the
    // preview node is not yet attached to its figure.
    const figureOf = () => shell.closest('figure');

    const toolbar = document.createElement('div');
    toolbar.classList.add(CLASS_NAMES.MU_HTML_FRAME_TOOLBAR);
    const pct = document.createElement('span');
    pct.classList.add('mu-html-frame-zoom');
    pct.textContent = '100%';
    pct.title = 'Reset zoom';
    const btnOut = document.createElement('button');
    btnOut.type = 'button';
    btnOut.textContent = '−';
    btnOut.title = 'Zoom out';
    const btnIn = document.createElement('button');
    btnIn.type = 'button';
    btnIn.textContent = '+';
    btnIn.title = 'Zoom in';
    toolbar.append(btnOut, pct, btnIn);

    const resizer = document.createElement('div');
    resizer.classList.add(CLASS_NAMES.MU_HTML_FRAME_RESIZER);
    resizer.title = 'Drag to resize';

    shell.append(frame, toolbar, resizer);

    // Keep author-specified CSS untouched; control size exclusively through
    // inline width/height once the user starts zooming/dragging.
    let baseW = 0;
    let baseH = 0;
    // 落盘的尺寸就是用户的意图：有存档时直接接管视口（userTouched = true），
    // 于是自适配高度不会再把用户调好的框覆盖掉。
    const saved = context.meta ?? {};
    const hasSavedFrame = typeof saved.width === 'number' && saved.width > 0;
    let curW = hasSavedFrame ? saved.width! : 0;
    let curH = typeof saved.height === 'number' && saved.height > 0 ? saved.height : 0;
    let curZoom = typeof saved.zoom === 'number' && Number.isFinite(saved.zoom)
        ? Math.min(FRAME_ZOOM_MAX, Math.max(FRAME_ZOOM_MIN, saved.zoom))
        : 1;
    let userTouched = hasSavedFrame;
    let frameLoaded = false;
    // 上一次写回文档的尺寸。只在与当前值不同时才写：pct 是「点回 100%」按钮，
    // 用户点一下不该产生一次文档变更。
    let writtenMeta: IHtmlFrameMeta = { ...saved };

    // 交互结束时把当前尺寸写回块状态（见文件头注释）。
    //
    // 复位（回到跟随布局）时 curW 归 0，写回的是空 meta —— 这正是要落盘的语义：
    // 「用户撤销了他调过的尺寸」，否则下次打开又冒出旧的存档尺寸。因此这里**不能**
    // 用 curW 做提前返回。
    const commitFrameMeta = () => {
        const next: IHtmlFrameMeta = {};

        // 0 表示视口已交还给作者 CSS（复位），此时不写宽高键 —— 与「从未调过尺寸」
        // 的块序列化出完全一样的文本。
        if (curW)
            next.width = Math.round(curW);

        if (curH)
            next.height = Math.round(curH);

        // 100% 是「没缩放过」的等价物，不写；于是复位后 meta 为空对象，序列化
        // 既不写注释行，也与「从未调过尺寸」的块无法区分 —— 正是期望的结果。
        if (curZoom !== 1)
            next.zoom = curZoom;

        if (JSON.stringify(next) === JSON.stringify(writtenMeta))
            return;

        writtenMeta = next;
        context.onCommit?.(next);
    };

    const apply = () => {
        // Hard guard: until the user explicitly zooms/drags (or a saved frame
        // size takes over), the frame keeps the author's CSS (`width:100%`)
        // untouched so it follows the editor layout (split view, window
        // resize). Any inline px write would permanently break that.
        if (!userTouched || !baseW || !frameLoaded)
            return;
        // Two independent controls, browser semantics:
        // - zoom (± / %): content scales like Chrome page zoom. The iframe
        //   gets CSS `zoom` and a compensated layout size (width ÷ zoom), so
        //   its VISUAL box — and the shell around it — keeps the user's
        //   viewport size while the embedded page reflows at a smaller
        //   layout viewport and is rendered bigger.
        // - drag: changes the real viewport size (curW/curH); the shell
        //   and the outer figure track it, so the whole block grows/shrinks.
        shell.style.width = `${curW}px`;
        const fig = figureOf();
        // max-width (not width): the Muya engine writes its own measured
        // inline width to the figure, which must not override the user's
        // shrunken viewport (otherwise a grey gutter stays behind).
        if (fig)
            fig.style.maxWidth = `${curW}px`;
        frame.style.zoom = `${curZoom}`;
        frame.style.width = `${curW / curZoom}px`;
        frame.style.height = `${curH / curZoom}px`;
        pct.textContent = `${Math.round(curZoom * 100)}%`;
    };

    // Drop every inline override so the author's CSS (width:100%) takes
    // over again and the block follows the editor layout.
    const release = () => {
        shell.style.width = '';
        const fig = figureOf();
        if (fig)
            fig.style.maxWidth = '';
        frame.setAttribute('style', authorStyle);
    };

    // Synchronous baseline read used by user actions. Gated on the iframe load
    // event: measuring before load can catch an unsettled layout (observed
    // 88%-width first-paint reads). Always re-anchors — `apply()` needs a
    // baseline even when a saved size took the viewport over on open.
    const readBaseNow = () => {
        if (!frameLoaded)
            return;
        baseW = frame.offsetWidth || baseW;
        baseH = frame.offsetHeight || FRAME_DEFAULT_HEIGHT;
    };

    const readBase = () => {
        // The Muya editor renders blocks incrementally, so a frame measured
        // in its first animation frame can catch an unsettled layout (the
        // first HTML block measured ~17% narrower than its siblings).
        // Re-read over two frames and keep the later value. Baseline only:
        // while untouched, the author's CSS (`width:100%`) keeps sizing the
        // frame natively.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                readBaseNow();
                // A late-loading frame whose saved size (or a pending zoom/drag)
                // outran the baseline anchors the viewport once it exists.
                if (userTouched && !curW && baseW) {
                    curW = baseW;
                    curH = baseH;
                }
                if (userTouched && curW)
                    apply();
            });
        });
    };

    // 自适配高度改了 frame 尺寸 → 重读基线（用户已接管时 readBaseNow 自己跳过）。
    frame.addEventListener(FRAME_HEIGHT_EVENT, readBase);

    // Once the frame has loaded (lazy iframes load late), re-anchor the
    // baseline at its final layout size.
    frame.addEventListener('load', () => {
        frameLoaded = true;
        if (!curW) {
            baseW = 0;
            readBase();
        }
    });

    // Before the user takes control, follow the editor layout (window
    // resize, sidebar toggle) exactly like a plain `width:100%` iframe.
    const observeLayout = new ResizeObserver(() => {
        if (!userTouched && baseW && baseW !== frame.offsetWidth) {
            readBase();
        }
    });
    observeLayout.observe(frame);

    // Geometric content zoom, bounded by FRAME_ZOOM_MIN/MAX. The viewport
    // (block) size stays untouched — Chrome page-zoom semantics.
    const zoomBy = (factor: number) => {
        userTouched = true;
        if (!frameLoaded || !baseW)
            return;
        // First user action anchors the working viewport at the baseline.
        if (!curW) {
            curW = baseW;
            curH = baseH;
        }
        curZoom = Math.min(
            FRAME_ZOOM_MAX,
            Math.max(FRAME_ZOOM_MIN, curZoom * factor),
        );
        apply();
        commitFrameMeta();
    };

    const zoomTo = (scale: number) => {
        if (!frameLoaded || !baseW || !Number.isFinite(scale))
            return;
        curZoom = Math.min(
            FRAME_ZOOM_MAX,
            Math.max(FRAME_ZOOM_MIN, scale),
        );
        if (curZoom === 1 && curW === baseW) {
            // Back to the pristine state: follow the editor layout again.
            userTouched = false;
            curW = 0;
            curH = 0;
            release();
            pct.textContent = '100%';
        }
        else {
            userTouched = true;
            if (!curW) {
                curW = baseW;
                curH = baseH;
            }
            apply();
        }
        // 复位（回到 100% 且与布局同宽）同样要落盘，否则下次打开还是旧的存档尺寸
        // ——「点复位」在用户看来就是「撤销我调过的尺寸」。
        commitFrameMeta();
    };

    const resizeTo = (width: number, height: number) => {
        userTouched = true;
        if (!baseW || !frameLoaded)
            return;
        curW = Math.max(FRAME_MIN_WIDTH, width);
        curH = Math.max(FRAME_MIN_HEIGHT, height);
        apply();
    };

    btnOut.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        zoomBy(1 / (1 + FRAME_ZOOM_STEP));
    });
    btnIn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        zoomBy(1 + FRAME_ZOOM_STEP);
    });
    pct.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        zoomTo(1);
    });

    // Stop hover-control clicks from leaking into editor block selection.
    toolbar.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    resizer.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
    });

    // Drag resize via pointer capture on the handle.
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartW = 0;
    let dragStartH = 0;
    resizer.addEventListener('pointerdown', (event) => {
        readBaseNow();
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        dragStartW = curW || baseW;
        dragStartH = curH || baseH;
        resizer.setPointerCapture(event.pointerId);
    });
    resizer.addEventListener('pointermove', (event) => {
        if (!resizer.hasPointerCapture(event.pointerId))
            return;
        resizeTo(
            dragStartW + (event.clientX - dragStartX),
            dragStartH + (event.clientY - dragStartY),
        );
    });
    // 拖拽只在抬手时落盘一次：拖动过程中每帧写回块状态会触发文档逐帧变更与保存，
    // 既闪烁又产生一堆无意义的撤销/IO。
    resizer.addEventListener('pointerup', (event) => {
        if (!resizer.hasPointerCapture(event.pointerId))
            return;

        resizer.releasePointerCapture(event.pointerId);
        commitFrameMeta();
    });
    resizer.addEventListener('pointercancel', () => {
        dragStartW = 0;
    });

    // Read the author CSS size once laid out. Also restore the px size after
    // scrolling re-renders (Muya may refresh preview blocks, see update()).
    requestAnimationFrame(readBase);

    return shell;
}

// 自适配高度的上限：一个失控的 scrollHeight（例如作者写了 100vh 的容器）不该
// 把文档撑成一屏空白；超过就让 frame 内部自己滚动，用户仍可用拖拽手柄改大小。
const FRAME_AUTOSIZE_MAX = 1200;
// 下限比拖拽用的 FRAME_MIN_HEIGHT 小：脚本块常是矮小的徽标/计数器，被撑到
// 160px 就只剩空白了。
const FRAME_AUTOSIZE_MIN = 60;

// 用户一旦动过缩放/拖拽手柄，尺寸就交给外壳（createFrameShell），自适配让位。
const autoSizeStop = new WeakSet<HTMLIFrameElement>();

function onFrameHeightMessage(event: MessageEvent) {
    const data = event.data as { type?: string; height?: unknown } | null;

    if (!data || data.type !== 'momark-html-frame-height')
        return;

    const height = Number(data.height);

    if (!Number.isFinite(height))
        return;

    // 只认沙箱脚本帧（src 指向引导页）自己发来的消息，因此不需要按块登记/解绑
    // 监听器 —— 块被重渲染丢弃后自然不再匹配。
    const frames = document.querySelectorAll<HTMLIFrameElement>(
        `iframe.${CLASS_NAMES.MU_HTML_IFRAME}[src*="${SCRIPT_FRAME_PAGE}"]`,
    );

    for (const frame of frames) {
        if (frame.contentWindow !== event.source || autoSizeStop.has(frame))
            continue;

        frame.style.height = `${Math.min(Math.max(Math.ceil(height), FRAME_AUTOSIZE_MIN), FRAME_AUTOSIZE_MAX)}px`;
        frame.dispatchEvent(new Event(FRAME_HEIGHT_EVENT));

        return;
    }
}

let heightListenerBound = false;

function bindHeightListenerOnce() {
    if (heightListenerBound)
        return;

    window.addEventListener('message', onFrameHeightMessage);
    heightListenerBound = true;
}

// 块内含脚本时的落点：整个块进沙箱 iframe，源码投递给引导页由它 document.write
// 执行；外壳沿用嵌入 iframe 的「缩放 + 拖拽」体验。
function createScriptFrame(source: string, context: IFrameShellContext): HTMLDivElement {
    bindHeightListenerOnce();

    const frame = document.createElement('iframe');
    rememberFrameSource(frame, source);
    // 与外部 iframe 嵌入同一条沙箱：脚本可跑，但拿不到同源身份，因此碰不到
    // 编辑器、文档与本地文件。
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', 'HTML');
    frame.setAttribute('style', `width:100%;height:${FRAME_DEFAULT_HEIGHT}px`);
    frame.classList.add(CLASS_NAMES.MU_HTML_IFRAME);
    frame.setAttribute('src', scriptFramePageUrl());

    // 引导页解析完自己的脚本后才挂上消息监听，因此等 load 再投递源码。
    // 文档被 document.write 重写会再触发一次 load，只投递第一次。
    let delivered = false;
    frame.addEventListener('load', () => {
        if (delivered)
            return;

        delivered = true;
        frame.contentWindow?.postMessage(buildFrameSourceMessage(source), '*');
    });

    const shell = createFrameShell(frame, context);
    // 用户一动手（拖拽尺寸或缩放，鼠标或键盘激活都算），尺寸就归外壳管，自适配让位。
    const stopAutoSize = () => autoSizeStop.add(frame);
    shell.addEventListener('pointerdown', stopAutoSize, true);
    shell.addEventListener('click', stopAutoSize, true);

    return shell;
}

class HTMLPreview extends Parent {
    private _html: string;

    // 当前沙箱脚本帧对应的源码（用于避免引擎刷新预览块时重载 srcdoc）。
    private _scriptFrameSource = '';

    // 块状态里的外框尺寸 + 写回通道（用户拖拽/缩放结束后调用）。
    private _frameMeta: IHtmlFrameMeta;
    private _commitFrameMeta: (meta: IHtmlFrameMeta) => void;

    static override blockName = 'html-preview';

    static create(muya: Muya, state: IHtmlBlockState) {
        const htmlBlock = new HTMLPreview(muya, state);

        return htmlBlock;
    }

    override get path() {
        debug.warn('You can never call `get path` in htmlPreview');
        return [];
    }

    constructor(muya: Muya, { text, meta }: IHtmlBlockState) {
        super(muya);
        this.tagName = 'div';
        this._html = text;
        this._frameMeta = { ...meta };
        this._commitFrameMeta = (next: IHtmlFrameMeta) => {
            // 尺寸归属 `figure.mu-html-block`（它才是 json state 里的块节点），
            // 预览只是它的 attachment —— 沿 parent 链找上去，找到才写。
            let node: Nullable<Parent> = this.parent;
            while (node) {
                if (node instanceof HTMLBlock) {
                    node.setFrameMeta(next);
                    return;
                }
                node = node.parent;
            }

            debug.warn('html-preview has no html-block ancestor; frame size not persisted.');
        };
        this.classList = [CLASS_NAMES.MU_HTML_PREVIEW];
        this.attributes = {
            spellcheck: 'false',
            contenteditable: 'false',
        };
        this.createDomNode();
        this.update();
    }

    update(html = this._html) {
        if (this._html !== html)
            this._html = html;

        const { disableHtml } = this.muya.options;

        // 块内含脚本 → 整个块进沙箱 iframe。净化会把 `<script>` 剥掉（交互原型
        // 与脚本图表正是靠脚本产出画面），所以这条路径不净化，安全由沙箱负责；
        // 作者源码本来就在 .md 里，因此单个文件发给别人、离线也能跑。
        // `disableHtml`（关闭 HTML 渲染）优先：此时照旧走净化/转义路径。
        //
        // 注意：沙箱帧是不透明源，块内若另外写 `<iframe src="本地文件">`，本地文件
        // 会被浏览器拒绝加载（远程 https 嵌入不受影响）——脚本与本地文件嵌入不要
        // 混在同一个块里。
        if (!disableHtml && hasInlineScript(html)) {
            // 引擎会因滚动/布局刷新预览块。脚本帧重挂会重载 srcdoc：画面闪一下、
            // 帧内状态（计数器、动画、滚动位置）清零。源码没变且外壳还在时直接复用。
            const shellAlive = this.domNode!.firstElementChild?.classList.contains(CLASS_NAMES.MU_HTML_FRAME);

            if (this._scriptFrameSource === html && shellAlive)
                return;

            this._scriptFrameSource = html;
            this.domNode!.innerHTML = '';
            this.domNode!.appendChild(createScriptFrame(html, this._frameContext()));

            return;
        }

        this._scriptFrameSource = '';

        // `<iframe>` cannot survive the DOMPurify html profile (USE_PROFILES
        // replaces the tag whitelist), so interactive embeds are swapped out
        // for inert text placeholders before sanitization and restored as real
        // sandboxed iframes afterwards.
        const frames = new Map<string, IIframeAttrs>();
        const htmlWithSlots = extractIframeSlots(html, frames);
        const htmlContent = sanitize(htmlWithSlots, PREVIEW_DOMPURIFY_CONFIG, disableHtml) as string;

        // handle empty html bock
        if (isEmptyHtmlBlock(htmlContent)) {
            this.domNode!.innerHTML
                = `<div class="${CLASS_NAMES.MU_EMPTY}">&lt;Empty HTML Block&gt;</div>`;
        }
        else {
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlContent, 'text/html');
            const imgs = doc.documentElement.querySelectorAll('img');

            for (const img of imgs) {
                const src = img.getAttribute('src')!;
                const imageSrc = getImageSrc(src);
                img.setAttribute('src', imageSrc.src);
            }

            this.domNode!.innerHTML
                = doc.documentElement!.querySelector('body')!.innerHTML;

            // Restore placeholders as real iframes. Scripts run behind an
            // opaque origin via `sandbox="allow-scripts"` (no
            // `allow-same-origin`), so the embedded page cannot touch the
            // editor or the local filesystem. No `loading="lazy"`: in the
            // split-view right pane the pane mounts mid-layout and Chromium
            // can classify the frame as off-viewport, leaving the block blank
            // until a scroll — HTML blocks are document content, load them
            // eagerly. Mirrors Typora's documented model ("scripts are
            // allowed inside an iframe but wrapped with sandbox attributes,
            // no access to your writing content nor local files").
            for (const [slot, attrs] of frames) {
                const holder = findFrameSlot(this.domNode!, slot);

                if (!holder)
                    continue;

                const frame = document.createElement('iframe');
                frame.setAttribute('src', getIframeSrc(attrs.src));
                frame.setAttribute('sandbox', 'allow-scripts');

                if (attrs.style)
                    frame.setAttribute('style', attrs.style);

                if (attrs.width)
                    frame.setAttribute('width', attrs.width);

                if (attrs.height)
                    frame.setAttribute('height', attrs.height);

                frame.setAttribute('title', attrs.title || attrs.src);
                frame.classList.add(CLASS_NAMES.MU_HTML_IFRAME);
                holder.replaceWith(createFrameShell(frame, this._frameContext()));
            }
        }
    }

    /**
     * 每次挂外壳都新建一份上下文：`meta` 是外壳的初始尺寸（打开文档即恢复用户
     * 上次调好的大小），`onCommit` 在用户交互结束时把新尺寸写回块状态 —— 写回会
     * 触发 json-change，于是文档被标记为「已修改」并走正常保存。
     */
    private _frameContext(): IFrameShellContext {
        return {
            meta: this._frameMeta,
            onCommit: (meta: IHtmlFrameMeta) => {
                this._frameMeta = meta;
                this._commitFrameMeta(meta);
            },
        };
    }

    override getState(): TState {
        debug.warn('You can never call `getState` in htmlPreview');
        return {} as TState;
    }
}

export default HTMLPreview;
