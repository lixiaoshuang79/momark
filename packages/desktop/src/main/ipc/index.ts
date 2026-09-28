import { registerBootInfo } from './bootInfo'
import { registerFsHandlers } from './fs'
import { registerPathHandlers } from './paths'
import { registerRipgrepHandlers } from './ripgrep'
import { registerUploaderHandlers } from './uploader'
import { registerFontsHandlers } from './fonts'
import { registerExportHtmlFrameHandlers } from './exportHtmlFrame'
import { registerShellHandlers } from './shell'
import { registerWindowHandlers } from './window'
import { registerCmdHandlers } from './cmd'
import { registerI18nHandlers } from './i18n'
import { registerAnnotationHandlers } from './annotation'
import { registerMomarkFileProtocol } from './momarkFileProtocol'
import { registerUpdaterHandlers } from './updater'
import { registerBrowserPanelIpc } from '../browserPanel'

export const registerSandboxIpcHandlers = (): void => {
  // A-12：本地图片协议（webSecurity 打开后渲染层唯一的本地图片入口）。
  // 必须在这里同步声明 scheme——`registerSchemesAsPrivileged` 只认 app ready
  // 之前的调用，而本函数正是 main/index.ts 顶层（ready 之前）执行的。
  registerMomarkFileProtocol()
  registerBootInfo()
  registerFsHandlers()
  registerPathHandlers()
  registerRipgrepHandlers()
  registerUploaderHandlers()
  registerFontsHandlers()
  registerExportHtmlFrameHandlers()
  registerShellHandlers()
  registerWindowHandlers()
  registerCmdHandlers()
  registerI18nHandlers()
  registerAnnotationHandlers()
  registerUpdaterHandlers()
  registerBrowserPanelIpc()
}
