// @vitest-environment happy-dom
import type { IHtmlBlockState } from '../../../../state/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../../../muya';
import ExportMarkdown from '../../../../state/stateToMarkdown';

// 外壳几何的落盘链路（DOM 级）：`state.meta` → 打开时恢复尺寸；用户拖拽抬手 /
// 点缩放按钮 → 尺寸写回 `state.meta` → 序列化成块前面的那行注释。
//
// 这里刻意不 mock Muya：外壳的初始尺寸来自真实构造出来的块状态，写回也真的走
// jsonState 的 replaceOperation。happy-dom 只提供 DOM 骨架，需要真实布局的地方
// （iframe 的 offsetWidth）由测试自己打桩。
const SCRIPT_BLOCK = '<div id="a">hi</div><script>document.getElementById("a").textContent = "1";</script>';
const hosts: HTMLElement[] = [];

afterEach(() => {
    while (hosts.length)
        hosts.pop()!.remove();
});

/** 让排队中的 requestAnimationFrame 回调跑完（引擎的尺寸写回是 rAF 批处理的）。 */
function flushFrames(times = 4): Promise<void> {
    return new Promise((resolve) => {
        let count = 0;
        const step = () => {
            count += 1;

            if (count >= times)
                resolve();
            else
                requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    });
}

async function boot(markdown: string, size: [number, number]) {
    window.MUYA_VERSION = 'test';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    hosts.push(muya.domNode);

    await vi.waitFor(() => {
        if (!muya.domNode.querySelector('.mu-html-frame'))
            throw new Error('frame shell not mounted');
    });

    const shell = muya.domNode.querySelector('.mu-html-frame') as HTMLElement;
    const frame = shell.querySelector('iframe') as HTMLElement;
    // happy-dom 不做布局，offsetWidth 恒为 0；外壳以「load 之后量一次」作为基线，
    // 所以这里打桩尺寸再补发 load（真实环境由浏览器发）。
    Object.defineProperty(frame, 'offsetWidth', { configurable: true, value: size[0] });
    Object.defineProperty(frame, 'offsetHeight', { configurable: true, value: size[1] });
    frame.dispatchEvent(new Event('load'));
    await flushFrames();

    return { muya, shell, frame };
}

function frameMeta(muya: Muya): unknown {
    const state = muya.getState()[0];

    if (state.name !== 'html-block')
        throw new Error('expected an html-block state');

    return (state as IHtmlBlockState).meta;
}

function toMarkdown(muya: Muya): string {
    return new ExportMarkdown({ listIndentation: 1 }).generate(muya.getState());
}

describe('内嵌 HTML 块外框尺寸 — 打开时恢复', () => {
    it('按块状态里的 meta 恢复尺寸与缩放', async () => {
        const { shell, frame } = await boot(`<!--momark-frame w=640 h=360 z=1.5-->\n${SCRIPT_BLOCK}\n`, [640, 360]);

        expect(shell.style.width).toBe('640px');
        expect(frame.style.zoom).toBe('1.5');
        // 缩放补偿：布局宽度 = 视口宽 ÷ 缩放，视觉尺寸才是用户存下的 640px。
        // CSS 序列化会做定点截断（426.6666666666667 → 426.666667），按数值比。
        expect(Number.parseFloat(frame.style.width)).toBeCloseTo(640 / 1.5, 5);
        expect(Number.parseFloat(frame.style.height)).toBeCloseTo(360 / 1.5, 5);
        expect(shell.querySelector('.mu-html-frame-zoom')!.textContent).toBe('150%');
    });

    it('没有 meta 的块保持作者 CSS（宽度仍是 100%）', async () => {
        const { shell, frame } = await boot(`${SCRIPT_BLOCK}\n`, [700, 420]);

        expect(shell.style.width).toBe('');
        expect(frame.style.width).toBe('100%');
    });
});

describe('内嵌 HTML 块外框尺寸 — 交互后写回', () => {
    it('点缩放按钮：写回 meta、发出 json-change 并序列化成注释', async () => {
        const { muya, shell } = await boot(`${SCRIPT_BLOCK}\n`, [700, 420]);
        const btnIn = shell.querySelectorAll('button')[1] as HTMLElement;
        // 变更通知走引擎既有的 `json-change`（desktop 侧 editor.vue 监听它来标记
        // 文档「已修改」并保存）；这里直接断言这条通道被触发。
        const changes: unknown[] = [];
        muya.on('json-change', payload => changes.push(payload));

        btnIn.click();
        await flushFrames();

        expect(changes).toHaveLength(1);
        expect(frameMeta(muya)).toEqual({ width: 700, height: 420, zoom: 1.1 });
        expect(toMarkdown(muya)).toBe(`<!--momark-frame w=700 h=420 z=1.1-->\n${SCRIPT_BLOCK}\n`);
    });

    it('拖拽只在抬手时写回一次', async () => {
        const { muya, shell } = await boot(`${SCRIPT_BLOCK}\n`, [700, 420]);
        const resizer = shell.querySelector('.mu-html-frame-resizer') as HTMLElement;
        const pointerId = 1;

        // happy-dom 的 pointer capture 是空实现，这里只让 hasPointerCapture 返回
        // true —— 外壳正是用「是否持有 capture」判断拖拽是否在进行中。
        resizer.hasPointerCapture = () => true;
        resizer.setPointerCapture = () => {};
        resizer.releasePointerCapture = () => {};

        resizer.dispatchEvent(Object.assign(new Event('pointerdown'), { clientX: 100, clientY: 100, pointerId }));
        resizer.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 340, clientY: 300, pointerId }));
        // 拖动过程中不写回：此时文档里还不该出现注释。
        expect(toMarkdown(muya)).not.toContain('momark-frame');

        await flushFrames();
        expect(toMarkdown(muya)).not.toContain('momark-frame');

        resizer.dispatchEvent(Object.assign(new Event('pointerup'), { clientX: 340, clientY: 300, pointerId }));
        await flushFrames();

        // 700 + 240 = 940，420 + 200 = 620。缩放仍是 100%（= 没缩放过），
        // 因此注释里不写 z 键。
        expect(frameMeta(muya)).toEqual({ width: 940, height: 620 });
        expect(toMarkdown(muya)).toBe(`<!--momark-frame w=940 h=620-->\n${SCRIPT_BLOCK}\n`);
    });

    it('点回 100% 复位：清掉存档尺寸，回到跟随布局', async () => {
        const { muya, shell } = await boot(`<!--momark-frame w=640 h=360 z=1.5-->\n${SCRIPT_BLOCK}\n`, [640, 360]);

        expect(shell.querySelector('.mu-html-frame-zoom')!.textContent).toBe('150%');
        (shell.querySelector('.mu-html-frame-zoom') as HTMLElement).click();
        await flushFrames();

        expect(frameMeta(muya)).toEqual({});
        expect(toMarkdown(muya)).toBe(`${SCRIPT_BLOCK}\n`);
    });
});
