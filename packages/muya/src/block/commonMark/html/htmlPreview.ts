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
        //   tracks it, so the whole block grows/shrinks.
        shell.style.width = `${curW}px`;
        frame.style.zoom = `${curZoom}`;
        frame.style.width = `${curW / curZoom}px`;
        frame.style.height = `${curH / curZoom}px`;
        pct.textContent = `${Math.round(curZoom * 100)}%`;
    };

    // Drop every inline override so the author's CSS (width:100%) takes
    // over again and the block follows the editor layout.
    const release = () => {
        shell.style.width = '';
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

class HTMLPreview extends Parent {
    private _html: string;

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
            // editor or the local filesystem; native `loading="lazy"` defers
            // rendering until the block scrolls into view. Mirrors Typora's
            // documented model ("scripts are allowed inside an iframe but
            // wrapped with sandbox attributes, no access to your writing
            // content nor local files").
            for (const [slot, attrs] of frames) {
                const holder = findFrameSlot(this.domNode!, slot);

                if (!holder)
                    continue;

                const frame = document.createElement('iframe');
                frame.setAttribute('src', getIframeSrc(attrs.src));
                frame.setAttribute('sandbox', 'allow-scripts');
                frame.setAttribute('loading', 'lazy');

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
