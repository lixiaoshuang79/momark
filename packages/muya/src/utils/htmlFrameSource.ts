// 脚本帧（内嵌 HTML 块）的「帧 → 源码」登记表。
//
// 单独放一个叶子模块，避免 ui/previewToolBar 为了拿源码去 import htmlPreview
// ——那条引用会把 htmlPreview 拉进工具条的依赖里形成环，包入口的部分导出会变成
// undefined（实测：6 个 entrypoint 导出用例连挂）。
//
// 用途：工具条「在侧栏打开」只拿得到 iframe 元素，而侧栏挂的是同一个引导页空壳
// （html-frame.html），父窗口换成右栏 iframe 后必须由父窗口投递源码才能 draw 出
// 内容；没有源码就是一片空白（用户实测反馈）。
const frameSources = new WeakMap<HTMLIFrameElement, string>();

export function rememberFrameSource(frame: HTMLIFrameElement, source: string): void {
    frameSources.set(frame, source);
}

export function getFrameSource(frame: Element | null | undefined): string {
    return frame instanceof HTMLIFrameElement ? frameSources.get(frame) ?? '' : '';
}
