import type Format from '../block/base/format';
import type { Muya } from '../muya';
import { BLOCK_DOM_PROPERTY, CLASS_NAMES } from '../config';
import { findContentDOM } from '../selection/dom';
import { getLinkInfo } from '../utils/getLinkInfo';

// The linkTools popover subscribes to `muya-link-tools` but had no emitter;
// this module is that emitter.
//
// Three rendered link variants are detected, each by its wrapper class:
//   - markdown `[text](href)`      → span.mu-inline-rule.mu-link
//   - reference link `[label][ref]` → a.mu-inline-rule.mu-reference-link
//                                       (or span.mu-reference-link if href
//                                        is not yet resolved — those are
//                                        intentionally *not* popover targets:
//                                        nothing to jump to or unlink)
//   - HTML `<a href=...>`          → a.mu-inline-rule.mu-raw-html
//
// For the markdown and reference-link variants we additionally require the
// preceding sibling to be `.mu-hide` — i.e. the source-character markers
// are hidden, which means the wrapper is rendered in *preview* mode
// (cursor isn't editing inside the link), which keeps the
// popover from flashing while the user types the URL.
//
// Click suppression: PR-11b removed the `pointer-events: none` rule that
// `inlineSyntax.css` used to set on link wrappers, because that rule
// hid all mouse events from us — events hit-tested straight through to
// the editor container. We compensate by `preventDefault()`-ing clicks
// on `a.mu-inline-rule` wrappers (standard contenteditable rich-text
// pattern: clicking a link inside the editor should place the cursor,
// not navigate away).
//
// Cleanup: every listener is attached via `eventCenter.attachDOMEvent`,
// so `muya.destroy()` → `eventCenter.detachAllDomEvents()` removes them.

// `mu-raw-html` is added to every inline HTML tag (`<u>`, `<mark>`,
// `<sub>`, `<sup>`, `<a>` …), so we can't match it loosely — narrow
// each entry by the actual tag the renderer emits.
export const LINK_SELECTOR = [
    `span.${CLASS_NAMES.MU_LINK}`,
    `a.${CLASS_NAMES.MU_REFERENCE_LINK}`,
    `a.${CLASS_NAMES.MU_RAW_HTML}`,
    `a.${CLASS_NAMES.MU_AUTO_LINK}`,
    `a.${CLASS_NAMES.MU_AUTO_LINK_EXTENSION}`,
].join(', ');

// Click suppression covers all real anchor variants whether or not they
// host a popover (no-text-link is `<a href target=_blank>` and would
// open a tab without this guard).
const ANCHOR_CLICK_SELECTOR = `a.${CLASS_NAMES.MU_INLINE_RULE}`;

function findLinkWrapper(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement))
        return null;

    return target.closest<HTMLElement>(LINK_SELECTOR);
}

// True for a Cmd-click (macOS) or Ctrl-click (other platforms). The desktop
// renderer makes the same OS distinction; emitting on either keeps muya
// platform-agnostic and lets the host decide.
function isModifierClick(event: Event): boolean {
    return event instanceof MouseEvent && (event.metaKey || event.ctrlKey);
}

// Auto-detected links are follow-only (no `[text](url)` source to rewrite).
// They open on plain click too — there is no source text to place the
// cursor into.
function isFollowOnly(wrapper: HTMLElement): boolean {
    return (
        wrapper.classList.contains(CLASS_NAMES.MU_AUTO_LINK)
        || wrapper.classList.contains(CLASS_NAMES.MU_AUTO_LINK_EXTENSION)
    );
}

function isPopoverTarget(wrapper: HTMLElement): boolean {
    // The edit/unlink popover doesn't apply to auto links — the URL
    // re-autolinks on the next render anyway.
    if (isFollowOnly(wrapper))
        return false;

    // HTML `<a>` is always a popover target — no source markers to hide.
    if (wrapper.classList.contains(CLASS_NAMES.MU_RAW_HTML))
        return true;

    // Markdown link / reference link: only show in preview mode (the
    // preceding `[` marker is hidden via `.mu-hide`).
    const prev = wrapper.previousElementSibling;

    return !!prev && prev.classList.contains(CLASS_NAMES.MU_HIDE);
}

export function attachLinkMouseHandlers(muya: Muya): void {
    const { eventCenter, domNode } = muya;

    const overHandler = (event: Event) => {
        // marktext `eventHandler/mouseEvent.js` gated the link-tools dispatch
        // on `!hideLinkPopup`: when the user sets `hideLinkPopup: true`, the
        // hover popover is suppressed entirely. Read it live so a runtime
        // `setOptions({ hideLinkPopup })` toggle takes effect immediately.
        if (muya.options?.hideLinkPopup)
            return;

        const wrapper = findLinkWrapper(event.target);
        if (!wrapper || !isPopoverTarget(wrapper))
            return;

        const linkInfo = getLinkInfo(wrapper);
        if (!linkInfo)
            return;

        // The unlink path needs the containing block so it can rewrite the
        // block's source text. Resolve it via the DOM-attached block ref
        // (the same property `selection/index.ts` uses for image clicks).
        const contentDom = findContentDOM(wrapper);
        const block = (contentDom?.[BLOCK_DOM_PROPERTY] ?? null) as Format | null;

        eventCenter.emit('muya-link-tools', {
            reference: wrapper,
            linkInfo,
            block,
        });
    };

    const outHandler = (event: Event) => {
        const wrapper = findLinkWrapper(event.target);
        if (!wrapper)
            return;

        // Ignore mouseout when the pointer is still inside the same wrapper
        // (e.g. crossing between a `<strong>` and the surrounding text child).
        // Without this guard the popover hides every time the pointer crosses
        // an internal element boundary.
        if (event instanceof MouseEvent) {
            const { relatedTarget } = event;
            if (relatedTarget instanceof Node && wrapper.contains(relatedTarget))
                return;
        }

        eventCenter.emit('muya-link-tools', { reference: null });
    };

    const clickHandler = (event: Event) => {
        if (!(event.target instanceof HTMLElement))
            return;

        // Suppress in-editor navigation for every real anchor variant. Place
        // the cursor instead of opening a tab (standard contenteditable
        // rich-text pattern). This runs for plain clicks too. Anchors inside a
        // raw HTML block preview (`.mu-html-preview a`) have no wrapper class,
        // so match them explicitly too.
        const anchor = event.target.closest<HTMLElement>(ANCHOR_CLICK_SELECTOR)
            ?? event.target.closest<HTMLElement>(`.${CLASS_NAMES.MU_HTML_PREVIEW} a[href]`);
        if (anchor)
            event.preventDefault();

        // 打开链接：普通点击也触发（宿主已拍板——正文点击链接默认在
        // 右侧边栏打开）。唯一例外：markdown/reference 链接处于编辑态
        // （源字符标记可见、非 popover target）时，普通点击保持纯光标
        // 定位，便于改链接文字/URL；预览态与自动链接/HTML 链接则直接
        // emit format-click。Cmd/Ctrl-click 仍全量触发。
        // `getLinkInfo` resolves the wrapper that hosts the href even when
        // the IMG/text descendant was clicked, and returns a superset
        // (`{ href, raw, text, range }`).
        const wrapper = findLinkWrapper(event.target);

        if (
            !isModifierClick(event)
            && wrapper
            && !isFollowOnly(wrapper)
            && !isPopoverTarget(wrapper)
        ) {
            return;
        }

        if (!wrapper) {
            // A link inside a raw HTML block renders into `.mu-html-preview` as
            // a plain `<a>` (no `mu-raw-html` wrapper), so it is not matched by
            // LINK_SELECTOR. Emit the jump for it directly.
            const previewAnchor = event.target.closest<HTMLAnchorElement>(
                `.${CLASS_NAMES.MU_HTML_PREVIEW} a[href]`,
            );
            const previewHref = previewAnchor?.getAttribute('href');
            if (previewAnchor && previewHref) {
                eventCenter.emit('format-click', {
                    event,
                    formatType: 'link',
                    data: {
                        href: previewHref,
                        raw: previewAnchor.outerHTML,
                        text: previewAnchor.textContent ?? '',
                    },
                });
            }

            return;
        }

        const linkInfo = getLinkInfo(wrapper);
        if (!linkInfo || !linkInfo.href)
            return;

        eventCenter.emit('format-click', {
            event,
            formatType: 'link',
            data: linkInfo,
        });
    };

    eventCenter.attachDOMEvent(domNode, 'mouseover', overHandler);
    eventCenter.attachDOMEvent(domNode, 'mouseout', outHandler);
    eventCenter.attachDOMEvent(domNode, 'click', clickHandler);
}
