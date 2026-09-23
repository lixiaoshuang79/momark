// 导出侧需要的「脚本帧 → 源码 + 当前显示尺寸」采集。
//
// 内嵌 HTML 块在编辑器里由 htmlPreview 挂成一个沙箱 iframe（外壳 `.mu-html-frame`）。
// 尺寸是会话内的：拖拽/缩放只写内联 style，从不写回 markdown（见 htmlPreview 里的
// 说明）。所以导出时要还原「用户看到的样子」，只能从 DOM 读当前显示尺寸，再把块源码
// 交给离屏渲染去截图。
//
// 单独放一个叶子模块：htmlPreview 那条引用链会跟工具条成环（见 htmlFrameSource 的
// 注释），这里只按类名查 DOM + 查源码登记表，不 import 任何块实现。

import { CLASS_NAMES } from '../config';
import { getFrameSource } from './htmlFrameSource';

export interface IHtmlFrameTarget {
    /** 块源码（原始 HTML，与投递给帧的完全一致） */
    html: string;
    /** 帧在编辑器里的显示宽度（CSS px，已含缩放的视觉尺寸） */
    width: number;
    /** 帧在编辑器里的显示高度（CSS px） */
    height: number;
    /** 帧的页面缩放倍数（Chrome 页面缩放语义，1 = 未缩放） */
    zoom: number;
    /**
     * 用户**没有**单独调过这个块的尺寸（跟随布局）。
     *
     * 编辑器里未调过的块不带内联宽度，由作者 CSS 的 `width:100%` 决定显示宽度 ——
     * 也就是说它「跟着正文栏走」，而不是「就是正文栏那么宽」。导出物里的正文栏比
     * 屏幕窄得多（导出页 `.markdown-body` 最大 980px 且居中），照搬这个像素宽会把
     * 原型挤在中间一条，两侧全是空白。所以导出侧对这类块改用「铺满页面可用宽度」，
     * 只有用户真的拖过尺寸（外壳带内联宽度）才按那个像素宽还原。
     */
    auto: boolean;
}

const MIN_SIZE = 1;

/**
 * 按文档顺序采集编辑器里所有「带沙箱帧」的内嵌 HTML 块。
 * 未带帧的块（块内没有 `<script>`，直接渲染进编辑器 DOM）不在此列——它们的
 * 源码在导出时本来就原样透传。
 */
export function collectHtmlFrameTargets(root: ParentNode | null | undefined): IHtmlFrameTarget[] {
    if (!root)
        return [];

    const targets: IHtmlFrameTarget[] = [];
    const shells = root.querySelectorAll(`.${CLASS_NAMES.MU_HTML_FRAME}`);

    for (const shell of shells) {
        const frame = shell.querySelector('iframe');
        if (!frame)
            continue;

        const html = getFrameSource(frame);
        if (!html)
            continue;

        const rect = shell.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (width < MIN_SIZE || height < MIN_SIZE)
            continue;

        const zoom = Number.parseFloat(getComputedStyle(frame).zoom) || 1;
        // 内联宽度只有用户拖过（或档里有存档尺寸）才存在；跟随布局的块没有。
        const explicitWidth = Number.parseFloat((shell as HTMLElement).style.width) || 0;
        targets.push({ html, width, height, zoom, auto: !explicitWidth });
    }

    return targets;
}
