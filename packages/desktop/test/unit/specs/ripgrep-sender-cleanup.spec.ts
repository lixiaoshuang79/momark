import { beforeEach, describe, expect, it, vi } from 'vitest'

// ────────────────────────────────────────────────────────────────────────────
// P3 主进程性能（ripgrep 搜索的 sender 监听）。
//
// `mt::rg::start` 每次搜索都会调 `cleanupAtSenderDestroy(sender)`，旧实现无条件
// `sender.once('destroyed', handler)` —— `once` 只在事件触发时才移除监听，于是
// 同一个 WebContents 上会随每次搜索累积一个永不触发的监听（「在文件夹中查找」
// 边打边搜几秒就能堆出上百个：EventEmitter max-listeners 告警、内存、以及销毁
// 时把同一份 activeSearches 遍历上百遍）。修复=每个 sender 只挂一次。
// ────────────────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

vi.mock('@vscode/ripgrep', () => ({ rgPath: '/fake/rg' }))

import { cleanupAtSenderDestroy } from 'main_renderer/ipc/ripgrep'

interface FakeSender {
  isDestroyed: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  destroyed: () => void
}

const makeSender = (): FakeSender => {
  let destroyed = false
  const handlers: Array<() => void> = []
  return {
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((_event: string, handler: () => void) => {
      handlers.push(handler)
      return undefined
    }),
    destroyed: () => {
      destroyed = true
      handlers.splice(0).forEach((handler) => handler())
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('P3 — ripgrep 不再给 sender 累积 destroyed 监听', () => {
  it('同一个 sender 搜索 50 次只挂 1 个 destroyed 监听', () => {
    const sender = makeSender()

    for (let i = 0; i < 50; i++) {
      cleanupAtSenderDestroy(sender as never)
    }

    expect(sender.once).toHaveBeenCalledTimes(1)
    expect(sender.once.mock.calls[0][0]).toBe('destroyed')
  })

  it('不同 sender 各自只挂一次（互不影响）', () => {
    const a = makeSender()
    const b = makeSender()

    cleanupAtSenderDestroy(a as never)
    cleanupAtSenderDestroy(b as never)
    cleanupAtSenderDestroy(a as never)
    cleanupAtSenderDestroy(b as never)

    expect(a.once).toHaveBeenCalledTimes(1)
    expect(b.once).toHaveBeenCalledTimes(1)
  })

  it('销毁之后重复调用仍然不会再挂（销毁时记录被清掉也不会重新累积）', () => {
    const sender = makeSender()

    cleanupAtSenderDestroy(sender as never)
    sender.destroyed()
    cleanupAtSenderDestroy(sender as never)
    cleanupAtSenderDestroy(sender as never)

    expect(sender.once).toHaveBeenCalledTimes(1)
  })

  it('已经销毁的 sender 不再挂监听（销毁时刻才拿到的搜索请求）', () => {
    const sender = makeSender()
    sender.destroyed()

    cleanupAtSenderDestroy(sender as never)

    expect(sender.once).not.toHaveBeenCalled()
  })

  it('sender 为空时不抛（handler 里 sender 可能已经取不到）', () => {
    expect(() => cleanupAtSenderDestroy(undefined)).not.toThrow()
    expect(() => cleanupAtSenderDestroy(null)).not.toThrow()
  })
})
