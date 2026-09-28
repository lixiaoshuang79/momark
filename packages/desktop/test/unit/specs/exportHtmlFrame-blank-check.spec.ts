import { describe, expect, it, vi } from 'vitest'

// ────────────────────────────────────────────────────────────────────────────
// P3 主进程性能（导出截图判空）的行为断言。
//
// 旧实现：等帧循环每 100ms 就对整帧调一次 `toBitmap()` —— 8000×8000 的帧一次
// 就是 256MB 的 BGRA 拷贝 + 最多 6400 万像素的 JS 遍历，最长 6 秒全压在主线程。
// 新实现：长边超过 512px 的帧先让原生侧降采样，再扫那张小图；判据（整帧里有
// 一个 alpha>8 且非近白的像素就算「画了东西」）与阈值不变。
// ────────────────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() }
}))

import { looksBlank } from 'main_renderer/ipc/exportHtmlFrame'

interface FakeImage {
  getSize: () => { width: number; height: number }
  resize: ReturnType<typeof vi.fn>
  toBitmap: ReturnType<typeof vi.fn>
}

/** 造一个位图替身：`pixels` 是 BGRA 四元组数组（不足的部分按空白补齐）。 */
const makeImage = (
  width: number,
  height: number,
  pixels: Array<[number, number, number, number]> = []
): FakeImage => {
  const bytes = Buffer.alloc(width * height * 4)
  pixels.forEach((pixel, index) => {
    const offset = index * 4
    if (offset + 3 < bytes.length) {
      bytes[offset] = pixel[0]
      bytes[offset + 1] = pixel[1]
      bytes[offset + 2] = pixel[2]
      bytes[offset + 3] = pixel[3]
    }
  })

  const image: FakeImage = {
    getSize: () => ({ width, height }),
    resize: vi.fn(() => makeImage(1, 1, pixels.slice(0, 1))),
    toBitmap: vi.fn(() => bytes)
  }
  return image
}

const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0]
const WHITE: [number, number, number, number] = [255, 255, 255, 255]
const BLACK: [number, number, number, number] = [0, 0, 0, 255]

describe('P3 — 导出截图判空不再整帧 toBitmap()', () => {
  it('大帧（8000×8000）先降采样：只扫长边 512px 的小图，绝不读原图位图', () => {
    const big = makeImage(8000, 8000, [WHITE])
    const small = makeImage(512, 512, [WHITE])
    big.resize.mockReturnValue(small)

    expect(looksBlank(big as unknown as Electron.NativeImage)).toBe(true)

    expect(big.resize).toHaveBeenCalledTimes(1)
    const options = big.resize.mock.calls[0][0] as { width: number; height: number }
    expect(Math.max(options.width, options.height)).toBeLessThanOrEqual(512)
    // 承重断言：256MB 的那次拷贝不再发生
    expect(big.toBitmap).not.toHaveBeenCalled()
    expect(small.toBitmap).toHaveBeenCalledTimes(1)
  })

  it('长边不超过 512px 的帧直接扫原图（不做无谓的 resize）', () => {
    const image = makeImage(320, 200, [WHITE])
    expect(looksBlank(image as unknown as Electron.NativeImage)).toBe(true)
    expect(image.resize).not.toHaveBeenCalled()
    expect(image.toBitmap).toHaveBeenCalledTimes(1)
  })

  it('判据不变：全透明 / 纯白算空，任意一个非白像素就不算空', () => {
    const blank = makeImage(8, 8, [TRANSPARENT, WHITE])
    expect(looksBlank(blank as unknown as Electron.NativeImage)).toBe(true)

    const withContent = makeImage(8, 8, [WHITE, WHITE, WHITE, BLACK])
    expect(looksBlank(withContent as unknown as Electron.NativeImage)).toBe(false)
  })

  it('alpha 太低的像素不算内容（与旧阈值一致）', () => {
    const nearlyTransparent = makeImage(4, 4, [[0, 0, 0, 8]])
    expect(looksBlank(nearlyTransparent as unknown as Electron.NativeImage)).toBe(true)

    const visible = makeImage(4, 4, [[0, 0, 0, 9]])
    expect(looksBlank(visible as unknown as Electron.NativeImage)).toBe(false)
  })

  it('空白大帧降采样后仍然判空；有内容的大帧降采样后仍判为「有内容」', () => {
    const blankBig = makeImage(8000, 8000, [WHITE])
    blankBig.resize.mockReturnValue(makeImage(512, 512, [WHITE]))
    expect(looksBlank(blankBig as unknown as Electron.NativeImage)).toBe(true)

    const contentBig = makeImage(8000, 8000, [WHITE])
    contentBig.resize.mockReturnValue(makeImage(512, 512, [WHITE, WHITE, BLACK]))
    expect(looksBlank(contentBig as unknown as Electron.NativeImage)).toBe(false)
  })

  it('空图（0×0）判为空且不触碰位图', () => {
    const empty = makeImage(0, 0)
    expect(looksBlank(empty as unknown as Electron.NativeImage)).toBe(true)
    expect(empty.toBitmap).not.toHaveBeenCalled()
    expect(empty.resize).not.toHaveBeenCalled()
  })
})
