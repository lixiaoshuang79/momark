import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdleCoalescer, createOwnWriteTracker } from '@/util/docPaneSync'

// 右栏分屏编辑器的按键路径：字数 / TOC 合并到空闲时推，回填 watch 靠本窗格自写
// 标记跳过自己的回声（不再每键整篇 getMarkdown 两次）。

// 自己的结构类型（不与 DOM 的 Window 相交）：测试需要把 rIC 置空走定时器分支。
type IdleHost = {
  requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

const w = window as unknown as IdleHost
const nativeRic = w.requestIdleCallback
const nativeCic = w.cancelIdleCallback

afterEach(() => {
  vi.useRealTimers()
  w.requestIdleCallback = nativeRic
  w.cancelIdleCallback = nativeCic
})

describe('createIdleCoalescer', () => {
  it('runs only the last task once when many keystrokes land before idle', () => {
    const callbacks: Array<() => void> = []
    w.requestIdleCallback = vi.fn((cb: () => void) => callbacks.push(cb))
    w.cancelIdleCallback = vi.fn()

    const coalescer = createIdleCoalescer()
    const ran: number[] = []
    for (let i = 1; i <= 5; i += 1) coalescer.schedule(() => ran.push(i))

    expect(w.requestIdleCallback).toHaveBeenCalledTimes(1)
    expect(w.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 300 })
    callbacks[0]()
    expect(ran).toEqual([5])

    // 执行完之后再登记，会重新挂一次空闲回调。
    coalescer.schedule(() => ran.push(6))
    expect(w.requestIdleCallback).toHaveBeenCalledTimes(2)
    callbacks[1]()
    expect(ran).toEqual([5, 6])
  })

  it('falls back to a 150ms timer without requestIdleCallback', () => {
    vi.useFakeTimers()
    w.requestIdleCallback = undefined
    const coalescer = createIdleCoalescer()
    const task = vi.fn()
    coalescer.schedule(task)
    coalescer.schedule(task)

    vi.advanceTimersByTime(149)
    expect(task).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('does nothing after cancel (component unmounted)', () => {
    vi.useFakeTimers()
    w.requestIdleCallback = undefined
    const coalescer = createIdleCoalescer()
    const task = vi.fn()
    coalescer.schedule(task)
    coalescer.cancel()

    vi.runAllTimers()
    expect(task).not.toHaveBeenCalled()
  })

  it('flush runs the pending task right away, once', () => {
    vi.useFakeTimers()
    w.requestIdleCallback = undefined
    const coalescer = createIdleCoalescer()
    const task = vi.fn()
    coalescer.schedule(task)

    coalescer.flush()
    expect(task).toHaveBeenCalledTimes(1)
    vi.runAllTimers()
    coalescer.flush()
    expect(task).toHaveBeenCalledTimes(1)
  })
})

describe('createOwnWriteTracker', () => {
  it('recognises the pane’s own write as an echo', () => {
    const tracker = createOwnWriteTracker()
    tracker.remember('# a\n')
    expect(tracker.isOwnEcho('# a\n')).toBe(true)
    // 同一个值的重复回声（例如两次连续 flush）仍然命中。
    expect(tracker.isOwnEcho('# a\n')).toBe(true)
  })

  it('does not swallow an external write (file watcher / left editor on the same doc)', () => {
    const tracker = createOwnWriteTracker()
    tracker.remember('# a\n')
    expect(tracker.isOwnEcho('# b\n')).toBe(false)
  })

  it('forgets the mark after a miss, so an external write back to the old text still syncs', () => {
    const tracker = createOwnWriteTracker()
    tracker.remember('A')
    // 外部改成 B → 右栏回填 B；外部再改回 A → 引擎此时是 B，必须再回填，不能当回声跳过。
    expect(tracker.isOwnEcho('B')).toBe(false)
    expect(tracker.isOwnEcho('A')).toBe(false)
  })

  it('reset (document switched) clears the mark', () => {
    const tracker = createOwnWriteTracker()
    tracker.remember('A')
    tracker.reset()
    expect(tracker.isOwnEcho('A')).toBe(false)
  })
})
