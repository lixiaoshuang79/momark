import type { Muya } from '../../../muya';
import type { IHtmlBlockState, TState } from '../../../state/types';
import { CLASS_NAMES, PREVIEW_DOMPURIFY_CONFIG } from '../../../config';
import { sanitize } from '../../../utils';
import { getIframeSrc, getImageSrc } from '../../../utils/image';
import logger from '../../../utils/logger';
import Parent from '../../base/parent';

const debug = logger('htmlPreview:');

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
// eslint-disable-next-line regexp/no-super-linear-backtracking
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
// 因此：块内出现 `<script>` 时，整个块改在沙箱 iframe 里渲染，srcdoc 用作者的
// **原始源码**（不能净化，否则脚本就没了）。安全靠沙箱而不是净化：`allow-scripts`
// 不带 `allow-same-origin`，脚本跑在不透明源里，既碰不到编辑器/文档，也读不到
// 本地文件 —— 与外部 iframe 嵌入（见上）同一套模型，也正是 Typora 的模型。
//
// 作者源码本来就在 .md 里（`_serializeHtmlBlock` 原样写回），所以一个文件发给
// 别人、离线打开，图照样画得出来。
const SCRIPT_TAG_REG = /<script[\s>/]/i;

export function hasInlineScript(html: string): boolean {
    return SCRIPT_TAG_REG.test(html);
}

// 注入到 srcdoc 末尾的自动高度上报：块内容多高、iframe 就多高，避免短片段的
// 图表被塞在 400px 的白框里（作者源码不受影响，只在渲染时拼接）。
const AUTOSIZE_SCRIPT = `<script>(function(){
  var post = function () {
    parent.postMessage({ type: 'momark-html-frame-height', height: Math.ceil(document.documentElement.scrollHeight) }, '*');
  };
  window.addEventListener('load', post);
  if (window.ResizeObserver) { new ResizeObserver(post).observe(document.documentElement); }
  post();
})();<\/script>`;

export function buildSandboxDocument(html: string): string {
    return `${html}\n${AUTOSIZE_SCRIPT}`;
}

// Wrap the restored iframe in a shell that adds two viewport controls:
// a hover zoom toolbar (− / +, percentage click resets to 100%) and a
// bottom-right drag handle that resizes the frame (the embedded page gets a
// real, different viewport and reflows). State is session-local on purpose:
// never written back into the source markdown.
function createFrameShell(frame: HTMLIFrameElement): HTMLDivElement {
    const shell = document.createElement('div');
    shell.classList.add(CLASS_NAMES.MU_HTML_FRAME);
    // The author's inline style (e.g. `width:100%;height:400px`) is
    // preserved verbatim: return to it when the user resets to 100%.
    const authorStyle = frame.getAttribute('style') ?? '';
    // The outer block container (`figure.mu-html-block`) must track the
    // viewport too: otherwise a shrunk frame leaves a grey gutter of the
    // container's own width on the right. Resolved lazily — during the
    // first update() the preview node is not yet attached to its figure.
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
    let curW = 0;
    let curH = 0;
    let curZoom = 1;
    let userTouched = false;
    let frameLoaded = false;

    // Synchronous baseline read used by user actions. Frozen once the user
    // has anchored a viewport (curW), so re-reading after every zoom would
    // compound (1.1x × 1.2x × … — reproduced as a 96k-px frame). Also gated
    // on the iframe load event: measuring before load can catch an unsettled
    // layout (observed 88%-width first-paint reads).
    const readBaseNow = () => {
        if (!frameLoaded || curW)
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
                // A late-loading frame with a pending zoom/drag anchors the
                // viewport and applies the user's settings once the
                // baseline exists.
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

    const apply = () => {
        // Hard guard: until the user explicitly zooms/drags, the frame keeps
        // the author's CSS (`width:100%`) untouched so it follows the editor
        // layout (split view, window resize). Any inline px write would
        // permanently break that.
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
            return;
        }
        userTouched = true;
        if (!curW) {
            curW = baseW;
            curH = baseH;
        }
        apply();
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

    // 只认沙箱脚本帧（`[srcdoc]`）自己发来的消息，因此不需要按块登记/解绑监听器
    // —— 块被重渲染丢弃后自然不再匹配。
    const frames = document.querySelectorAll<HTMLIFrameElement>(`iframe.${CLASS_NAMES.MU_HTML_IFRAME}[srcdoc]`);

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

// 块内含脚本时的落点：整个块进沙箱 iframe（srcdoc = 作者原始源码），外壳沿用
// 嵌入 iframe 的「缩放 + 拖拽」体验。
function createScriptFrame(source: string): HTMLDivElement {
    bindHeightListenerOnce();

    const frame = document.createElement('iframe');
    // 与外部 iframe 嵌入同一条沙箱：脚本可跑，但拿不到同源身份，因此碰不到
    // 编辑器、文档与本地文件。
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', 'HTML');
    frame.setAttribute('style', `width:100%;height:${FRAME_DEFAULT_HEIGHT}px`);
    frame.classList.add(CLASS_NAMES.MU_HTML_IFRAME);
    frame.srcdoc = buildSandboxDocument(source);

    const shell = createFrameShell(frame);
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

    static override blockName = 'html-preview';

    static create(muya: Muya, state: IHtmlBlockState) {
        const htmlBlock = new HTMLPreview(muya, state);

        return htmlBlock;
    }

    override get path() {
        debug.warn('You can never call `get path` in htmlPreview');
        return [];
    }

    constructor(muya: Muya, { text }: IHtmlBlockState) {
        super(muya);
        this.tagName = 'div';
        this._html = text;
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
            this.domNode!.appendChild(createScriptFrame(html));

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
                holder.replaceWith(createFrameShell(frame));
            }
        }
    }

    override getState(): TState {
        debug.warn('You can never call `getState` in htmlPreview');
        return {} as TState;
    }
}

export default HTMLPreview;
