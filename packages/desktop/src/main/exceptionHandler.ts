// Based on electron-unhandled by sindresorhus:
//
// MIT License
// Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { app, clipboard, dialog, ipcMain } from 'electron'
import os from 'os'
import log from 'electron-log'
import { createAndOpenGitHubIssueUrl } from './utils/createGitHubIssue'
import { t } from './i18n'

type ErrorType = 'main' | 'renderer'
type Logger = (s: string) => void

const EXIT_ON_ERROR = !!process.env.MARKTEXT_EXIT_ON_ERROR
const SHOW_ERROR_DIALOG = !process.env.MARKTEXT_ERROR_INTERACTION
const ERROR_MSG_MAIN = (): string => t('error.unexpectedMainProcess')
const ERROR_MSG_RENDERER = (): string => t('error.unexpectedRendererProcess')

/**
 * 未捕获异常模态框的去重窗口（P3）。
 *
 * 同一个错误（同类型 + 同标题 + 同 message + 同 stack）在这个窗口内只弹一次；
 * 窗口外再出现仍会弹——避免「一次性的错误永远看不到」，同时挡住
 * 「过期窗口 id 反复抛异常」这类风暴。日志不受影响，每次都照写。
 */
const DIALOG_DEDUPE_WINDOW_MS = 60_000
/** 两个**不同**错误之间的最小间隔，防止一堆不同的错误轮流弹框。 */
const DIALOG_MIN_GAP_MS = 5_000
/** 去重表的容量上限（超过就丢掉最老的一条）。 */
const MAX_TRACKED_ERRORS = 32

/** 已弹过模态框的错误签名 → 最近一次弹出的时间。 */
const shownErrorDialogs = new Map<string, number>()
let lastDialogShownAt = 0
let dialogVisible = false

const errorSignature = (title: string, error: Error, type: ErrorType): string =>
  `${type}|${title}|${error.message}|${error.stack ?? ''}`

/**
 * 这个错误现在该不该弹模态框（去重 + 限频）。
 *
 * 暴露给单测（`test/unit/specs/exception-dialog-throttle.spec.ts`）。
 */
export const shouldShowErrorDialog = (signature: string, now: number = Date.now()): boolean => {
  // 上一个模态框还开着：记日志就好，不要再叠一个（模态框是阻塞式的，
  // 叠起来只能被用户一条条点掉，等于卡住界面）。
  if (dialogVisible) {
    return false
  }
  for (const [key, shownAt] of shownErrorDialogs) {
    if (now - shownAt > DIALOG_DEDUPE_WINDOW_MS) {
      shownErrorDialogs.delete(key)
    }
  }
  if (shownErrorDialogs.has(signature)) {
    return false
  }
  if (now - lastDialogShownAt < DIALOG_MIN_GAP_MS) {
    return false
  }
  if (shownErrorDialogs.size >= MAX_TRACKED_ERRORS) {
    const oldest = [...shownErrorDialogs.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest) {
      shownErrorDialogs.delete(oldest[0])
    }
  }
  shownErrorDialogs.set(signature, now)
  lastDialogShownAt = now
  return true
}

/** 仅供单测：清空去重/限频状态。 */
export const resetErrorDialogThrottle = (): void => {
  shownErrorDialogs.clear()
  lastDialogShownAt = 0
  dialogVisible = false
}

let logger: Logger = (s) => console.error(s)

const getOSInformation = (): string => {
  return `${os.type()} ${os.arch()} ${os.release()} (${os.platform()})`
}

const exceptionToString = (error: Error, type: ErrorType): string => {
  const { message, stack } = error
  return (
    `Version: ${MARKTEXT_VERSION_STRING || app.getVersion()}\n` +
    `OS: ${getOSInformation()}\n` +
    `Type: ${type}\n` +
    `Date: ${new Date().toUTCString()}\n` +
    `Message: ${message}\n` +
    `Stack: ${stack}\n`
  )
}

const handleError = async (title: string, error: Error, type: ErrorType): Promise<void> => {
  const { message, stack } = error

  // Write error into file
  if (type === 'main') {
    logger(exceptionToString(error, type))
  }

  if (EXIT_ON_ERROR) {
    console.log(t('error.terminatedDueToError'))
    process.exit(1)
    // eslint, don't lie to me, the return statement is important!
    return
  } else if (
    !SHOW_ERROR_DIALOG ||
    ((global as unknown as { MARKTEXT_IS_STABLE?: boolean }).MARKTEXT_IS_STABLE &&
      type === 'renderer')
  ) {
    return
  }

  // show error dialog
  if (app.isReady()) {
    // P3：去重 + 限频。同一个错误（含 stack）在窗口内只弹一次，且两个模态框之间
    // 至少隔 DIALOG_MIN_GAP_MS；被压掉的仍然进了日志（上面 logger 已写）。
    const signature = errorSignature(title, error, type)
    if (!shouldShowErrorDialog(signature)) {
      log.error(`Suppressed a repeated exception dialog (${type}): ${message}`)
      return
    }

    dialogVisible = true
    try {
      // Blocking message box
      const { response } = await dialog.showMessageBox({
        type: 'error',
        buttons: [t('common.ok'), t('error.copyError'), t('error.report')],
        defaultId: 0,
        noLink: true,
        message: title,
        detail: stack
      })

      switch (response) {
        case 1: {
          clipboard.writeText(`${title}\n${stack}`)
          break
        }
        case 2: {
          const issueTitle = message ? t('error.unexpectedErrorWithMessage', { message }) : title
          createAndOpenGitHubIssueUrl(
            issueTitle,
            `### Description

${title}.

### Minimal Reprouducible Markdown Example (or Steps)

<Add steps or a markdown example to reproduce the problem.>

### Stack Trace

\`\`\`\n${stack}\n\`\`\`

### Version

墨记: ${MARKTEXT_VERSION_STRING}
Operating system: ${getOSInformation()}`
          )
          break
        }
      }
    } finally {
      dialogVisible = false
    }
  } else {
    // error during Electron initialization
    dialog.showErrorBox(title, stack ?? '')
    process.exit(1)
  }
}

const setupExceptionHandler = (): void => {
  // macOS reports EIO for revoked terminal descriptors; other platforms
  // commonly report EPIPE for the same closed-output condition.
  const ignoreBrokenOutputPipe = (err: NodeJS.ErrnoException): void => {
    if (err.code !== 'EPIPE' && err.code !== 'EIO') throw err
  }
  process.stdout.on('error', ignoreBrokenOutputPipe)
  process.stderr.on('error', ignoreBrokenOutputPipe)

  // main process error handler
  process.on('uncaughtException', (error: Error) => {
    handleError(ERROR_MSG_MAIN(), error, 'main')
  })

  // renderer process error handler
  ipcMain.on('mt::handle-renderer-error', (_e, error: Error) => {
    handleError(ERROR_MSG_RENDERER(), error, 'renderer')
  })

  // P3：同一个异常不再弹两个模态框。electron-log 的 errorHandler 默认
  // `showDialog = true`（`src/node/ErrorHandler.js`），未捕获异常会走它自己的
  // `dialog.showErrorBox`，再加上本文件的 `dialog.showMessageBox` —— 一次异常
  // 两个框。它在 index.ts 里通过 `log.errorHandler.startCatching({ onError })`
  // 注册，而 `startCatching` 走的是 `setOptions`：只有显式传 boolean 才会改写
  // showDialog，这里先把它关掉（本函数在 `initializeLogger()` 之前执行），
  // 弹框只留本文件这一条路径。
  log.errorHandler.setOptions({ showDialog: false })

  // P3：`crashReporter.start` 不再在这里调。index.ts 里已经启动过一次
  // （productName '墨记' + uploadToServer: false + compress: true，本地留存），
  // 这里再调一次是重复启动（报告点名的「被调两次」），而 Electron 对
  // crashReporter 的重复 start 并不会叠加出第二份崩溃报告。
}

export const initExceptionLogger = (): void => {
  // replace placeholder logger
  logger = log.error as unknown as Logger
}

export default setupExceptionHandler
