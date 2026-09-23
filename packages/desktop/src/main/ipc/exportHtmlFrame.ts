import { BrowserWindow, ipcMain } from 'electron'
import log from 'electron-log'
import type {
  IRasterizeHtmlFrameArgs,
  IRasterizeHtmlFrameResult
} from '../../shared/types/exportHtmlFrame'

// 导出时把「内嵌 HTML 块」按它在编辑器里的尺寸离屏重放，并截成一张 PNG。
//
// 为什么必须离屏：块尺寸是会话内的（拖拽/缩放只写内联 style，从不写回 markdown），
// 导出又是从 markdown 重新渲染的，所以只能拿当前显示尺寸把块重画一遍。
//
// 为什么用 offscreen 渲染（实测依据，别再退回 capturePage）：
//   1. 普通隐藏窗口不参与合成 —— `capturePage` 拿到的是一张纯白图（窗口压根没画过）；
//      把窗口显示到屏幕外，也只有「落在屏幕内」的那条能截到，屏幕放不下的块会被裁掉。
//   2. offscreen 模式下 Chromium 在软件里出帧、通过 `paint` 事件交付：不需要窗口出现
//      在屏幕上，也不受屏幕尺寸限制，块比屏幕高也能完整截下来。
//   3. offscreen 渲染**不合成 `<iframe>` 的内容** —— 实测：顶层 DOM 改动出 28553 个非白
//      像素，再加一个铺满颜色的沙箱帧只多 11 个。所以这里把作者源码直接 document.write
//      进离屏窗口自己的文档，而不是像编辑器那样塞进沙箱帧里重放。窗口不带 Node、不带
//      preload、开 sandbox，作者脚本碰不到应用与本地文件（file:// 之间的 XHR 默认被拦）。
//
// 缩放语义与编辑器一致：都是「页面缩放」——文档拿到的 CSS 视口 = 显示尺寸 ÷ 缩放，
// 再按缩放渲染，所以这里用 webContents.setZoomFactor。

const MIN_SIZE = 1
const MAX_SIZE = 8000
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
/** 等第一次内容高度上报；超时不再等（块坏了也不能卡住导出）。 */
const FIRST_REPORT_TIMEOUT_MS = 3000
/** 高度连续安静这么久即认为内容稳定（图表重绘、字体加载都会继续上报）。 */
const QUIET_MS = 320
/** 等内容稳定的上限。 */
const MAX_SETTLE_MS = 4000
/** 一次都没有上报时的兜底等待。 */
const FALLBACK_SETTLE_MS = 800
/** 等一帧「画了东西」的帧的上限。 */
const PAINT_TIMEOUT_MS = 6000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const clampSize = (value: number): number =>
  Math.min(Math.max(Math.round(Number(value) || MIN_SIZE), MIN_SIZE), MAX_SIZE)

const clampZoom = (value: number): number =>
  Math.min(Math.max(Number(value) || 1, MIN_ZOOM), MAX_ZOOM)

/** 采样位图，判断这一帧是不是「什么都没画」（全透明或纯白）。 */
const looksBlank = (image: Electron.NativeImage): boolean => {
  const bitmap = image.toBitmap()
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    // BGRA
    const b = bitmap[i]
    const g = bitmap[i + 1]
    const r = bitmap[i + 2]
    const a = bitmap[i + 3]
    if (a > 8 && (r < 246 || g < 246 || b < 246)) return false
  }
  return true
}

const buildInjectScript = (html: string): string => `(() => {
  const SOURCE = ${JSON.stringify(html)}
  window.__momarkCaptureHeights = []
  const report = () => {
    if (document.documentElement)
      window.__momarkCaptureHeights.push(Math.ceil(document.documentElement.scrollHeight))
  }
  document.open()
  document.write(SOURCE)
  document.close()
  if (window.ResizeObserver) new ResizeObserver(report).observe(document.documentElement)
  window.addEventListener('load', report)
  report()
  setTimeout(report, 120)
  setTimeout(report, 600)
  return true
})()`

const rasterize = async (
  args: IRasterizeHtmlFrameArgs
): Promise<IRasterizeHtmlFrameResult | null> => {
  const width = clampSize(args.width)
  const height = clampSize(args.height)
  const zoom = clampZoom(args.zoom)

  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      // 软件离屏渲染：不需要窗口出现在屏幕上，paint 事件直接把帧交过来。
      offscreen: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 截图窗口不碰编辑器的缓存与 cookie。
      partition: 'momark-html-capture'
    }
  })

  let latest: Electron.NativeImage | null = null
  win.webContents.setFrameRate(30)
  win.webContents.on('paint', (_event, _dirty, image) => {
    latest = image
  })
  // 取值走函数：paint 回调里的赋值 TS 控制流分析看不到，直接读会被窄化成 null。
  const currentFrame = (): Electron.NativeImage | null => latest

  try {
    await win.loadURL(args.shellUrl)
    win.webContents.setZoomFactor(zoom)
    await win.webContents.executeJavaScript(buildInjectScript(args.html))

    const reportDeadline = Date.now() + FIRST_REPORT_TIMEOUT_MS
    let reported = false
    while (Date.now() < reportDeadline) {
      reported =
        ((await win.webContents.executeJavaScript(
          'window.__momarkCaptureHeights.length'
        )) as number) > 0
      if (reported) break
      await sleep(60)
    }

    // 等高度安静下来（图表重绘、字体加载会继续上报）；等不到就按兜底时长硬等。
    let lastHeight = Number.NaN
    let quietSince = Date.now()
    const settleDeadline = Date.now() + (reported ? MAX_SETTLE_MS : FALLBACK_SETTLE_MS)
    while (Date.now() < settleDeadline) {
      const current = (await win.webContents.executeJavaScript(
        'window.__momarkCaptureHeights[window.__momarkCaptureHeights.length - 1] ?? -1'
      )) as number
      if (current !== lastHeight) {
        lastHeight = current
        quietSince = Date.now()
      } else if (Date.now() - quietSince >= QUIET_MS) {
        break
      }
      await sleep(80)
    }

    // 取一帧「画了东西」的内容：document.write 之后的第一帧可能还是空白。
    const paintDeadline = Date.now() + PAINT_TIMEOUT_MS
    let frame: Electron.NativeImage | null = null
    while (Date.now() < paintDeadline) {
      const candidate = currentFrame()
      if (candidate && !looksBlank(candidate)) {
        frame = candidate
        break
      }
      await sleep(100)
    }

    // 拿不到内容就返回 null，让上层按原样导出，绝不塞一张白图进文档。
    if (!frame) {
      log.warn('[export] 内嵌 HTML 块离屏渲染没有出帧（内容为空）')
      return null
    }

    const size = frame.getSize()
    if (!size.width || !size.height) {
      log.warn('[export] 内嵌 HTML 块截图尺寸异常')
      return null
    }

    return {
      dataUrl: frame.toDataURL(),
      width: size.width,
      height: size.height,
      scale: size.width / width
    }
  } catch (err) {
    log.error('[export] 内嵌 HTML 块离屏截图失败:', err)
    return null
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export const registerExportHtmlFrameHandlers = (): void => {
  ipcMain.handle(
    'mt::export::rasterize-html-frame',
    async (_event, args: IRasterizeHtmlFrameArgs) => rasterize(args)
  )
}
