import { app, net, protocol } from 'electron'
import log from 'electron-log'

import {
  MOMARK_FILE_SCHEME,
  isAllowedMomarkFileExtension,
  momarkFileUrlToPath
} from '@shared/types/momarkFile'

/**
 * 本地图片协议（A-12）——把 `momark-file://local/<绝对路径>` 映射到磁盘上的图片。
 *
 * 为什么要自己起一个协议而不是继续用 `file://`：见 `@shared/types/momarkFile`
 * 的文件头（dev 形态与沙箱帧都加载不了 file://）。
 *
 * 权限声明：`standard`（有 host/path 语义，才能被 <img> 与 CSP 正常对待）、
 * `secure`（当作可信来源，避免被当混合内容拦掉）、`supportFetchAPI`（引擎的
 * `checkImageContentType` 会用 fetch 读 Content-Type）。
 *
 * 读取范围：只放行图片扩展名（`MOMARK_FILE_ALLOWED_EXTENSIONS`）。协议是给
 * `<img>` 用的，绝不能变成渲染层的「任意文件读取」后门——那正是恢复 webSecurity
 * 想收掉的能力。
 */

/**
 * 路径 → `file://` URL。与引擎侧 `muya/src/utils/image.ts#localPathToFileUrl`
 * 同形（UNC / 盘符 / POSIX 三种），这里是主进程读盘用的那一份。
 * 导出出来是为了单测能直接钉住三种形态（协议处理器内部也用它）。
 */
export const momarkFilePathToFileUrl = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/')
  if (/^\/\/[^/]+\/[^/]+/.test(normalized)) return `file://${normalized.slice(2)}`
  if (/^[a-z]:\//i.test(normalized)) return `file:///${normalized}`
  return `file://${normalized}`
}

/**
 * 必须在 `app` ready **之前**调用（Chromium 只接受启动期的 scheme 声明）。
 * `registerSandboxIpcHandlers()` 在 main/index.ts 顶层同步执行，满足该时序。
 */
export const registerMomarkFileScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MOMARK_FILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true
      }
    }
  ])
}

/** 注册协议处理器（app ready 之后才允许）。 */
export const installMomarkFileProtocol = (): void => {
  protocol.handle(MOMARK_FILE_SCHEME, async (request) => {
    const filePath = momarkFileUrlToPath(request.url)
    if (!filePath || !isAllowedMomarkFileExtension(filePath)) {
      log.warn('[momark-file] refused (not an image / bad url):', request.url)
      return new Response('Forbidden', { status: 403 })
    }
    try {
      return await net.fetch(momarkFilePathToFileUrl(filePath))
    } catch (err) {
      // 文件不存在 / 权限不足：返回 404，让 <img> 走引擎既有的失败态
      // （显示「加载图片失败」），不要抛到协议层。
      log.warn('[momark-file] read failed:', filePath, err)
      return new Response('Not Found', { status: 404 })
    }
  })
}

/** 声明 + 注册（install 挂在 whenReady 上，先声明后注册的时序由 Electron 要求）。 */
export const registerMomarkFileProtocol = (): void => {
  registerMomarkFileScheme()
  app.whenReady().then(() => {
    installMomarkFileProtocol()
  })
}
