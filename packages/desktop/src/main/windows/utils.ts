import { BrowserWindow, screen } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import { isLinux } from '../config'

export const zoomIn = (win: BrowserWindow | null | undefined): void => {
  if (!win) return
  const { webContents } = win
  const zoom = webContents.getZoomFactor()
  // WORKAROUND: We need to set zoom on the browser window due to Electron#16018.
  webContents.send('mt::window-zoom', Math.min(2.0, zoom + 0.125))
}

export const zoomOut = (win: BrowserWindow | null | undefined): void => {
  if (!win) return
  const { webContents } = win
  const zoom = webContents.getZoomFactor()
  // WORKAROUND: We need to set zoom on the browser window due to Electron#16018.
  webContents.send('mt::window-zoom', Math.max(0.5, zoom - 0.125))
}

export const resetZoom = (win: BrowserWindow | null | undefined): void => {
  if (!win) return
  const { webContents } = win
  // WORKAROUND: We need to set zoom on the browser window due to Electron#16018.
  webContents.send('mt::window-zoom', 1.0)
}

export const centerWindowOptions = (
  options: BrowserWindowConstructorOptions & {
    width: number
    height: number
    x?: number
    y?: number
  }
): void => {
  // "workArea" doesn't work on Linux
  const { bounds, workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const screenArea = isLinux ? bounds : workArea
  const { width, height } = options
  options.x = Math.ceil(screenArea.x + (screenArea.width - width) / 2)
  options.y = Math.ceil(screenArea.y + (screenArea.height - height) / 2)
}

export interface WindowStateLike {
  x?: number
  y?: number
  width: number
  height: number
}

export const ensureWindowPosition = (
  windowState: WindowStateLike
): { x: number; y: number; width: number; height: number } => {
  // "workArea" doesn't work on Linux
  const { bounds, workArea } = screen.getPrimaryDisplay()
  const screenArea = isLinux ? bounds : workArea

  let { x, y, width, height } = windowState
  let center = false
  if (x === undefined || y === undefined) {
    center = true

    // First app start; check whether window size is larger than screen size
    if (screenArea.width < width) width = screenArea.width
    if (screenArea.height < height) height = screenArea.height
  } else {
    center = !screen
      .getAllDisplays()
      .map(
        (display) =>
          x! >= display.bounds.x &&
          x! <= display.bounds.x + display.bounds.width &&
          y! >= display.bounds.y &&
          y! <= display.bounds.y + display.bounds.height
      )
      .some((display) => display)
  }
  if (center) {
    x = Math.ceil(screenArea.x + (screenArea.width - width) / 2)
    y = Math.ceil(screenArea.y + (screenArea.height - height) / 2)
  }
  return {
    x: x as number,
    y: y as number,
    width,
    height
  }
}

/**
 * 显示器拔掉 / 配置变化后，把落在所有显示器之外的窗口拉回主屏居中。
 *
 * 典型场景：窗口原本在外接显示器上，拔线后 macOS 不会动它——窗口「消失」，
 * 用户以为应用坏了（实测反馈：「打开一个文档结果连窗口都没有」，进程与渲染
 * 都健在，只是窗口坐标在屏幕外）。启动时的 `ensureWindowPosition` 只管首次
 * 恢复，运行中的显示器变化要靠这里。
 */
export const keepWindowsOnScreen = (): void => {
  const displays = screen.getAllDisplays()

  for (const win of BrowserWindow.getAllWindows()) {
    // 最小化的窗口由系统自己管位置；全屏窗口离开全屏后再校验也不迟。
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) continue

    const bounds = win.getBounds()
    // 与任一显示器的工作区**有交集**才算可见（只比较原点会把「大部分在屏幕外、
    // 只露一角」的窗口也放过）。
    const visible = displays.some((display) => {
      const area = display.workArea

      return (
        bounds.x < area.x + area.width &&
        bounds.x + bounds.width > area.x &&
        bounds.y < area.y + area.height &&
        bounds.y + bounds.height > area.y
      )
    })

    if (visible) continue

    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(bounds.width, area.width)
    const height = Math.min(bounds.height, area.height)
    win.setBounds({
      x: Math.ceil(area.x + (area.width - width) / 2),
      y: Math.ceil(area.y + (area.height - height) / 2),
      width,
      height
    })
  }
}
