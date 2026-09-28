// Visible line count for a code block, matching marktext `a028a7c2`:
//   - each `\n` adds a row
//   - a trailing `\n` still counts as the next visible (empty) row in
//     contenteditable, which falls out naturally from "count + 1"
//
// Implemented with a charCode loop (no regex match array allocation —
// this is called on every code-block update, including large pasted blobs).
const LF = 10;

export function computeLineCount(text: string): number {
    let count = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === LF)
            count++;
    }
    return count;
}

export const LINE_NUMBERS_ROWS_CLASS = 'mu-line-numbers-rows';

// The wrapper starts empty; CodeBlockContent.update() syncs spans on demand
// via `syncLineNumbersSpans` (delta updates, no full innerHTML rewrite).
export function lineNumbersWrapperHTML(): string {
    return `<span class="${LINE_NUMBERS_ROWS_CLASS}" contenteditable="false" aria-hidden="true"></span>`;
}

// Add or remove `<span>` children so wrapper.childElementCount === count.
// O(delta), not O(count) — typing within a line is free once the count
// matches.
export function syncLineNumbersSpans(wrapper: HTMLElement, count: number): void {
    let current = wrapper.childElementCount;
    while (current < count) {
        wrapper.appendChild(wrapper.ownerDocument.createElement('span'));
        current++;
    }
    while (current > count) {
        wrapper.lastElementChild!.remove();
        current--;
    }
}

// Measure the actual visual top of every logical line using Range API, then
// set `top` on each span so line numbers align correctly in wrap mode (where
// a single logical line can span multiple visual rows).
//
// Two passes on purpose: every measurement is taken before the first write.
// Interleaving a `range.getBoundingClientRect()` (forced layout) with a
// `span.style.top = …` (invalidates layout) made each of the N lines re-run
// layout, so a long code block paid an O(lines) layout per reposition — and
// reposition runs on every content edit and every block resize. Batching the
// reads collapses that to a single layout.
//
// Must run after layout (call via requestAnimationFrame).
export function repositionLineNumberSpans(
    wrapper: HTMLElement,
    codeEl: HTMLElement,
): void {
    const spans = Array.from(wrapper.children) as HTMLElement[];
    if (spans.length === 0)
        return;

    const text = codeEl.textContent ?? '';

    // Global character offsets where each logical line begins.
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === LF)
            lineStarts.push(i + 1);
    }

    // Pass 1 (reads only): walk all text nodes once, recording the measured top
    // of every line start.
    const measuredTops: number[] = [];
    const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
    const range = document.createRange();

    let nodeStart = 0;
    let lineIdx = 0;
    // Origin = the measured top of the first logical line. A collapsed range's
    // rect top sits at the text/caret box (below the line-box leading), so
    // subtracting the wrapper top would offset every number down by that
    // constant leading. Anchoring to the first line cancels it and keeps line 1
    // flush with the gutter top, while preserving correct per-line deltas for
    // wrap mode.
    let baseTop: number | null = null;
    let node = walker.nextNode() as Text | null;

    while (node !== null && lineIdx < lineStarts.length) {
        const nodeLen = (node.textContent ?? '').length;
        const nodeEnd = nodeStart + nodeLen;

        // A line start may be INSIDE this node (< nodeEnd); if it equals nodeEnd
        // it belongs to the next node and will be picked up on the next iteration.
        while (lineIdx < lineStarts.length && lineStarts[lineIdx] < nodeEnd) {
            const offsetInNode = lineStarts[lineIdx] - nodeStart;
            range.setStart(node, offsetInNode);
            range.collapse(true);
            const measured = range.getBoundingClientRect().top;
            if (baseTop === null)
                baseTop = measured;
            measuredTops.push(measured - baseTop);
            lineIdx++;
        }

        nodeStart = nodeEnd;
        node = walker.nextNode() as Text | null;
    }

    // Lines with no text node to measure from: the trailing empty line after a
    // final "\n", or the single line of a wholly empty code block. The first
    // line is always flush with the top; later ones stack one line-height below
    // their predecessor.
    if (lineIdx < spans.length) {
        const lineH = Number.parseFloat(getComputedStyle(wrapper).lineHeight) || 24;
        for (let i = lineIdx; i < spans.length; i++) {
            const prevTop = i > 0 ? (measuredTops[i - 1] ?? 0) : 0;
            measuredTops.push(i > 0 ? prevTop + lineH : 0);
        }
    }

    // Pass 2 (writes only): apply the measured offsets in one batch.
    for (let i = 0; i < spans.length; i++) {
        if (i < measuredTops.length)
            spans[i].style.top = `${measuredTops[i]}px`;
    }
}
