/**
 * 右栏分屏编辑器的按键路径工具（docEditorPane.vue）。
 *
 * 每个 `json-change` 原本同步做两次整篇 `getMarkdown()`（推 store 一次、回填
 * watch 比字符串又一次）+ 整篇字数 + TOC 遍历，大文档上全压在打字路径里。
 * 这里两件小工具把其中可省的部分拿掉：字数/TOC 合并到空闲时推，回填 watch
 * 靠「本窗格自写标记」认出自己刚推上去的值，不再为它重新序列化。
 */

export interface IdleCoalescer {
  // 登记任务：挂起期间再登记只替换任务，空闲时只跑最后一次登记的那个。
  schedule: (task: () => void) => void
  // 立刻执行挂起的任务（换文档 / 卸载前用，免得最后一次按键的统计丢失）。
  flush: () => void
  cancel: () => void
}

type IdleHost = {
  requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

// 时限与左编辑器 scheduleDerivedStats 一致：空闲回调最晚 300ms，无 rIC 时 150ms。
export const createIdleCoalescer = ({
  timeout = 300,
  fallbackMs = 150
}: { timeout?: number; fallbackMs?: number } = {}): IdleCoalescer => {
  let task: (() => void) | null = null
  let cancelPending: (() => void) | null = null

  const run = (): void => {
    cancelPending = null
    const next = task
    task = null
    next?.()
  }

  return {
    schedule(next) {
      task = next
      if (cancelPending) return
      const host = window as unknown as IdleHost
      if (typeof host.requestIdleCallback === 'function') {
        const handle = host.requestIdleCallback(run, { timeout })
        cancelPending = () => host.cancelIdleCallback?.(handle)
      } else {
        const handle = window.setTimeout(run, fallbackMs)
        cancelPending = () => window.clearTimeout(handle)
      }
    },
    flush() {
      if (!cancelPending) return
      cancelPending()
      run()
    },
    cancel() {
      cancelPending?.()
      cancelPending = null
      task = null
    }
  }
}

export interface OwnWriteTracker {
  // 记下本窗格刚写进 store 的值（store 规整后的那份，见 adjustTrailingNewlines）。
  remember: (markdown: string) => void
  // 回填 watch 用：命中 = 自己刚写的回声，可跳过。未命中即作废标记——之后哪怕
  // 外部又写回同一个字符串，也要老老实实比对、回填（否则引擎会停在中间那份）。
  isOwnEcho: (markdown: string) => boolean
  reset: () => void
}

// 只记本窗格自己的写入：不能复用 store 的 `fromEngine` 标记——那是按标签 id
// 共享的，左编辑器的双开同步 watch 会据它跳过，同一文档左右双开时右栏的编辑
// 就同步不到左栏了。
export const createOwnWriteTracker = (): OwnWriteTracker => {
  let last: string | null = null
  return {
    remember(markdown) {
      last = markdown
    },
    isOwnEcho(markdown) {
      if (last !== null && markdown === last) return true
      last = null
      return false
    },
    reset() {
      last = null
    }
  }
}
