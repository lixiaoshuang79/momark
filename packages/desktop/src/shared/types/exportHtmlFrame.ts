/**
 * 导出时把「内嵌 HTML 块的沙箱帧」离屏复现成一张图片的 IPC 契约。
 *
 * 为什么需要它：编辑器里的块尺寸是**会话内**的（拖拽/缩放只写内联 style，从不写回
 * markdown），而导出是把 markdown 重新渲染一遍（`exportStyledHTML` → marked），脚本
 * 会被 DOMPurify 剥掉/转义。于是导出物里那块要么空白、要么只剩一段可见的源码文本。
 * 解决办法：按当前显示尺寸把块离屏渲染一次并截图，导出前替换进 markdown。
 */

export interface IRasterizeHtmlFrameArgs {
  /**
   * 引导页 URL。由渲染层按 `document.baseURI` 解析后传入，保证离屏窗口与编辑器
   * 加载的是同一个 `html-frame.html`（相对路径的解析基准也因此一致）。
   */
  shellUrl: string
  /** 块源码（与投递给编辑器里那个帧的一致） */
  html: string
  /** 帧在编辑器里的显示宽度（CSS px） */
  width: number
  /** 帧在编辑器里的显示高度（CSS px） */
  height: number
  /** 帧的页面缩放倍数（Chrome 页面缩放语义，1 = 未缩放） */
  zoom: number
}

export interface IRasterizeHtmlFrameResult {
  /** PNG data URL */
  dataUrl: string
  /** 截图像素宽度（含设备像素比；CSS 尺寸仍以请求的 width/height 为准） */
  width: number
  /** 截图像素高度 */
  height: number
  /** 实际像素密度 = width / 请求宽度 */
  scale: number
}
