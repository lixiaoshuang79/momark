import { expect, test } from '../fixtures/muya';

// Regression: a percentage `--editor-area-width` (the desktop app's default is
// `100%`) used to collapse inline math. The width cap sat on
// `.mu-math-render`, whose containing block is the auto-width `.mu-math`
// inline-block — so `calc(100% - 100px)` resolved against the formula's own
// shrink-to-fit width: formulas under 100px rendered at 0px (blank), longer
// ones lost everything past `width - 100px` (truncated). The cap now lives on
// `.mu-math`, where the percentage resolves against the paragraph.
test('inline math keeps its full width under a percentage editor width', async ({ page }) => {
    await page.addStyleTag({ content: ':root { --editor-area-width: 100%; }' });
    await page.evaluate(() => {
        window.muya!.setContent(
            'length $L$, gate $L \\ge 10$, ratio $\\text{overlap}(Q, S_i) = \\frac{|B(Q) \\cap B(S_i)|}{|B(Q)|}$.',
        );
    });

    const cells = await page.evaluate(() =>
        [...document.querySelectorAll('.mu-math')].map((math) => {
            const render = math.querySelector('.mu-math-render') as HTMLElement;
            return {
                width: Math.round(render.getBoundingClientRect().width),
                scrollWidth: render.scrollWidth,
            };
        }),
    );

    expect(cells).toHaveLength(3);
    for (const { width, scrollWidth } of cells) {
        expect(width).toBeGreaterThan(0);
        expect(width).toBe(scrollWidth);
    }
});

// The #4339 behavior must survive: a formula wider than the editor column is
// capped at the column width and scrolls horizontally.
test('a long formula still caps at the editor width and scrolls', async ({ page }) => {
    await page.addStyleTag({ content: ':root { --editor-area-width: 320px; }' });
    await page.evaluate(() => {
        const terms = Array.from({ length: 32 }, (_, i) => `x_{${i + 1}}`).join('+');
        window.muya!.setContent(`$${terms}$`);
    });

    const result = await page.evaluate(() => {
        const render = document.querySelector('.mu-math-render') as HTMLElement;
        const style = getComputedStyle(render);
        return {
            width: render.getBoundingClientRect().width,
            scrollWidth: render.scrollWidth,
            overflowX: style.overflowX,
            // `.mu-container` is 320px wide with 50px padding per side.
            columnWidth: (render.closest('.mu-content') as HTMLElement).getBoundingClientRect().width,
        };
    });

    expect(result.overflowX).toBe('auto');
    expect(result.width).toBeLessThanOrEqual(result.columnWidth + 1);
    expect(result.scrollWidth).toBeGreaterThan(result.width);
});
