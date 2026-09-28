import { ipcMain } from 'electron'
import log from 'electron-log'
import { isSamePathSync, isImageFile } from 'common/filesystem/paths'

import { isTrustedIpcSender, trustedHandle } from './guard'

export const registerPathHandlers = (): void => {
  // The renderer's preload computes isChildOfDirectory / hasMarkdownExtension
  // locally (pure string ops, no IPC). Only `is-same-sync` and `is-image`
  // require fs in the rare case-insensitive / image-file path checks.
  //
  // 同步通道不能走 trustedOn（拒绝时要回一个值，否则渲染层的 sendSync 拿到
  // undefined）：这里显式写回 `false`（preload 的 isSamePathSync 只在大小写
  // 不一致时才会走到这条通道，回 false 等于「按不同路径处理」，是保守解）。
  ipcMain.on('mt::paths::is-same-sync', (event, a: string, b: string) => {
    if (!isTrustedIpcSender(event)) {
      log.warn('[ipc] refused mt::paths::is-same-sync from untrusted sender')
      event.returnValue = false
      return
    }
    event.returnValue = isSamePathSync(a, b, true)
  })
  trustedHandle('mt::paths::is-image', (_e, p: string) => isImageFile(p))
}
