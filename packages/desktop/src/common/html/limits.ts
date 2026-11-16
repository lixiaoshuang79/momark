/**
 * 打开本地 .html 的体积上限。原型页（含内联图片/字体）通常几 MB，32MB 足够；
 * 再大就不是「评审用原型」了，整段源码要经 IPC 送到渲染层再 postMessage 进帧，
 * 拒绝比让窗口卡住强。
 */
export const HTML_FILE_MAX_BYTES = 32 * 1024 * 1024

/** 内联时单个本地资源（CSS / JS / 图片）的磁盘体积上限。 */
export const HTML_INLINE_RESOURCE_MAX_BYTES = 8 * 1024 * 1024

/**
 * 内联后整份文档（入口原文 + 读进来的资源，图片按 base64 膨胀后计）的上限，与
 * 入口同为 32MB：内联产物要么投进右栏帧、要么写进 .md，不应比直接打开的 .html 更大。
 */
export const HTML_INLINE_TOTAL_MAX_BYTES = HTML_FILE_MAX_BYTES
