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
                holder.replaceWith(frame);
            }
        }
    }

    override getState(): TState {
        debug.warn('You can never call `getState` in htmlPreview');
        return {} as TState;
    }
}

export default HTMLPreview;
