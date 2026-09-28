import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ────────────────────────────────────────────────────────────────────────────
// P3 主进程性能/稳定性（未捕获异常弹框）。
//
// 旧状况：未捕获异常有三处挂钩，其中两处会各弹一个模态框（本文件的
// `dialog.showMessageBox` + electron-log errorHandler 的 `showErrorBox`），
// 而且完全不限频——像 `getWindowMenuById` 收到过期窗口 id 这类会反复出现的错误
// 就是「弹窗风暴」；`crashReporter.start` 还被调了两次。
// ────────────────────────────────────────────────────────────────────────────

const electronMock = vi.hoisted(() => ({
  app: { getVersion: vi.fn(() => '1.5.0'), isReady: vi.fn(() => true) },
  clipboard: { writeText: vi.fn() },
  crashReporter: { start: vi.fn() },
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 0 }))
  },
  ipcMain: { on: vi.fn() }
}))

const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  errorHandler: { setOptions: vi.fn() }
}))

vi.mock('electron', () => electronMock)
vi.mock('electron-log', () => ({ default: logMock }))
vi.mock('../../../src/main/i18n', () => ({ t: (key: string) => key }))
vi.mock('../../../src/main/utils/createGitHubIssue', () => ({
  createAndOpenGitHubIssueUrl: vi.fn()
}))

// `MARKTEXT_VERSION_STRING` 是 electron-vite 打包时注入的全局量，单测里不存在
// （`exceptionToString` 直接引用它）。
;(globalThis as unknown as { MARKTEXT_VERSION_STRING: string }).MARKTEXT_VERSION_STRING =
  '1.5.0-test'

const {
  default: setupExceptionHandler,
  resetErrorDialogThrottle,
  shouldShowErrorDialog
} = await import('../../../src/main/exceptionHandler')

type ErrorHandler = (error: Error) => void

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

/** 注册一次处理器，拿回 `uncaughtException` 的回调。 */
const captureUncaughtHandler = (): ErrorHandler => {
  const handlers: ErrorHandler[] = []
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: ErrorHandler) => {
    if (event === 'uncaughtException') handlers.push(handler)
    return process
  }) as typeof process.on)
  vi.spyOn(process.stdout, 'on').mockImplementation(
    (() => process.stdout) as typeof process.stdout.on
  )
  vi.spyOn(process.stderr, 'on').mockImplementation(
    (() => process.stderr) as typeof process.stderr.on
  )
  setupExceptionHandler()
  if (handlers.length === 0) throw new Error('uncaughtException handler was not registered')
  return handlers[0]!
}

beforeEach(() => {
  vi.clearAllMocks()
  resetErrorDialogThrottle()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('P3 — 未捕获异常只留一个弹框路径', () => {
  it('只注册一个 uncaughtException 处理器，且不再第二次启动 crashReporter', () => {
    captureUncaughtHandler()

    const uncaughtRegistrations = (
      process.on as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((call) => call[0] === 'uncaughtException')
    expect(uncaughtRegistrations).toHaveLength(1)

    // index.ts 已经在启动时 start 过一次（productName/uploadToServer 都在那边配），
    // 这里再调一次就是重复启动——报告点名的「crashReporter.start 被调两次」。
    expect(electronMock.crashReporter.start).not.toHaveBeenCalled()
  })

  it('关掉 electron-log 自带的未捕获异常弹框（否则一次异常两个模态框）', () => {
    captureUncaughtHandler()
    expect(logMock.errorHandler.setOptions).toHaveBeenCalledWith({ showDialog: false })
  })

  it('同一个异常反复抛只弹一次（去重）', async () => {
    const handleUncaught = captureUncaughtHandler()
    const error = new Error('Cannot find window menu for id 42.')

    for (let i = 0; i < 5; i++) {
      handleUncaught(error)
    }
    await flushMicrotasks()

    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    // 被压掉的仍然进日志（每次都要留痕）
    expect(logMock.error).toHaveBeenCalled()
  })

  it('不同异常在最小间隔内也只弹一次（限频），间隔过后恢复', async () => {
    const handleUncaught = captureUncaughtHandler()
    const now = Date.now()

    handleUncaught(new Error('first'))
    await flushMicrotasks()
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledTimes(1)

    // 另一个错误，但在 5s 最小间隔内 → 不发第二个模态框
    handleUncaught(new Error('second'))
    await flushMicrotasks()
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledTimes(1)

    // 时间过了最小间隔（去重窗口内仍算同一条 → 直接查内部判定函数）
    expect(shouldShowErrorDialog('other|title|msg|stack', now + 10_000)).toBe(true)
  })

  it('弹框还开着的时候不再叠第二个', async () => {
    let resolveFirst: (value: { response: number }) => void = () => {}
    electronMock.dialog.showMessageBox.mockImplementationOnce(
      () =>
        new Promise<{ response: number }>((resolve) => {
          resolveFirst = resolve
        })
    )

    const handleUncaught = captureUncaughtHandler()
    handleUncaught(new Error('slow dialog'))
    await flushMicrotasks()

    // 第一个框还没关，第二个错误到来 → 不叠框
    handleUncaught(new Error('another while open'))
    await flushMicrotasks()
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledTimes(1)

    resolveFirst({ response: 0 })
    await flushMicrotasks()
  })
})

describe('P3 — shouldShowErrorDialog 的去重与限频语义', () => {
  it('首次放行；去重窗口内同一签名被压掉；窗口外恢复', () => {
    const base = 1_000_000
    expect(shouldShowErrorDialog('sig', base)).toBe(true)
    expect(shouldShowErrorDialog('sig', base + 1_000)).toBe(false)
    expect(shouldShowErrorDialog('sig', base + 60_001)).toBe(true)
  })

  it('不同签名之间也受最小间隔约束', () => {
    const base = 2_000_000
    expect(shouldShowErrorDialog('a', base)).toBe(true)
    expect(shouldShowErrorDialog('b', base + 1)).toBe(false)
    expect(shouldShowErrorDialog('b', base + 5_001)).toBe(true)
  })

  it('去重表有容量上限（不会随签名数量无界增长）', () => {
    const base = 3_000_000
    for (let i = 0; i < 200; i++) {
      shouldShowErrorDialog(`sig-${i}`, base + i * 10_000)
    }
    // 上限内最老的一条会被挤掉：老的签名在窗口之外再出现仍会被放行
    expect(shouldShowErrorDialog('sig-199', base + 199 * 10_000 + 61_000)).toBe(true)
  })
})
