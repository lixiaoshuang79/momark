import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(), isReady: vi.fn() },
  clipboard: { writeText: vi.fn() },
  crashReporter: { start: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
  ipcMain: { on: vi.fn() }
}))

vi.mock('electron-log', () => ({
  // P3：`setupExceptionHandler` 现在会关掉 electron-log 自带的未捕获异常弹框
  // （否则一次异常弹两个模态框），所以 errorHandler 也要在替身里出现。
  default: { error: vi.fn(), errorHandler: { setOptions: vi.fn() } }
}))

vi.mock('../../../src/main/i18n', () => ({
  t: (key: string) => key
}))

vi.mock('../../../src/main/utils/createGitHubIssue', () => ({
  createAndOpenGitHubIssueUrl: vi.fn()
}))

import setupExceptionHandler from '../../../src/main/exceptionHandler'

type OutputErrorHandler = (error: NodeJS.ErrnoException) => void

describe('main process output error handling', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ignores revoked-pipe EIO errors without hiding unrelated output failures', () => {
    let stdoutHandler: OutputErrorHandler | undefined

    vi.spyOn(process.stdout, 'on').mockImplementation(((
      event: string,
      listener: OutputErrorHandler
    ) => {
      if (event === 'error') stdoutHandler = listener
      return process.stdout
    }) as typeof process.stdout.on)
    vi.spyOn(process.stderr, 'on').mockImplementation(
      (() => process.stderr) as typeof process.stderr.on
    )
    vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on)

    setupExceptionHandler()
    if (!stdoutHandler) throw new Error('stdout error handler was not registered')
    const handleOutputError = stdoutHandler

    const eio = Object.assign(new Error('write EIO'), { code: 'EIO' })
    const enospc = Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' })
    expect(() => handleOutputError(eio)).not.toThrow()
    expect(() => handleOutputError(enospc)).toThrow(enospc)
  })
})
