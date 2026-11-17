import type { OffsetOptions, Placement } from '@floating-ui/dom';

export interface IBaseOptions {
    placement: Placement;
    offsetOptions: OffsetOptions;
    showArrow: boolean;
    /**
     * 设置后给 floating-ui 加 `shift` 中间件（值为离视口边缘的像素内边距）：
     * 卡片靠边时被夹回窗口内。`flip` 只换上下/左右，居中放置的浮层在贴边时
     * 仍会有一半伸出窗口（用户实测：标注卡片跑到窗口左边外面）。
     */
    shiftPadding?: number;
}
