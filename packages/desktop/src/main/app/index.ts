import path from 'path'
import fsPromises from 'fs/promises'
import { exec } from 'child_process'
import dayjs from 'dayjs'
import log from 'electron-log'
import { app, BrowserWindow, clipboard, dialog, nativeTheme, shell, ipcMain } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import { isChildOfDirectory, MARKDOWN_EXTENSIONS } from 'common/filesystem/paths'
import { isFile2 } from 'common/filesystem'
import type { IUserPreferences } from '@shared/types/preferences'
import { isLinux, isOsx, isWindows } from '../config'
import parseArgs from '../cli/parser'
import { normalizeAndResolvePath } from '../filesystem'
import { normalizeMarkdownPath } from '../filesystem/markdown'
import { registerKeyboardListeners } from '../keyboard'
import { selectTheme } from '../menu/actions/theme'
import { dockMenu } from '../menu/templates'
import registerSpellcheckerListeners from '../spellchecker'
import { watchers } from '../utils/imagePathAutoComplement'
import { onInternalChannel } from '../utils/internalIpc'
import { WindowType } from '../windows/base'
import EditorWindow from '../windows/editor'
import SettingWindow from '../windows/setting'
import WelcomeWindow from '../windows/welcome'
import AboutWindow from '../windows/about'
import { setLanguage, t } from '../i18n'
import { getNativeThemeSource, isDarkApplicationTheme } from './nativeTheme'
import { installBrowserPanelSecurity, installPanelZoomKeyRouting } from '../browserPanel'
import type Accessor from './accessor'
import type WindowManager from './windowManager'

interface CliArgs {
  _: string[]
  [flag: string]: unknown
}

interface PathInfo {
  isDir: boolean
  path: string
}

class App {
  private _accessor: Accessor
  private _args: CliArgs
  private _openFilesCache: PathInfo[]
  private _openFilesTimer: ReturnType<typeof setTimeout> | null
  private _windowManager: WindowManager
  private _themeListenerRegistered: boolean

  /**
   * @param accessor The application accessor for application instances.
   * @param args Parsed application arguments.
   */
  constructor(accessor: Accessor, args: Partial<CliArgs>) {
    this._accessor = accessor
    this._args = (args as CliArgs) || ({ _: [] } as CliArgs)
    this._openFilesCache = []
    this._openFilesTimer = null
    this._windowManager = this._accessor.windowManager
    // this.launchScreenshotWin = null // The window which call the screenshot.
    // this.shortcutCapture = null

    // Initialize main process language
    this._initializeLanguage()
    this._listenForIpcMain()
    // Initialize theme listener
    this._themeListenerRegistered = false
  }

  /**
   * The entry point into the application.
   */
  init(): void {
    // Enable these features to use `backdrop-filter` css rules!
    if (isOsx) {
      app.commandLine.appendSwitch('enable-experimental-web-platform-features', 'true')
    }

    app.on('second-instance', (_event, argv, workingDirectory) => {
      const { _openFilesCache, _windowManager } = this
      log.info('[second-instance] argv:', argv.slice(1).join(' '))
      const args = parseArgs(argv.slice(1)) as CliArgs

      const buf: PathInfo[] = []
      for (const pathname of args._) {
        // Ignore all unknown flags
        if (pathname.startsWith('--')) {
          continue
        }

        const info = normalizeMarkdownPath(path.resolve(workingDirectory, pathname))
        if (info) {
          buf.push(info as PathInfo)
        }
      }

      if (args['--new-window']) {
        this._openPathList(buf, true)
        return
      }

      _openFilesCache.push(...buf)
      if (_openFilesCache.length) {
        this._openFilesToOpen()
      } else {
        const activeWindow = _windowManager.getActiveWindow()
        if (activeWindow) {
          activeWindow.bringToFront()
        }
      }
    })

    app.on('open-file', this.openFile) // macOS only

    app.on('ready', this.ready)

    app.on('window-all-closed', () => {
      // Close all the image path watcher
      for (const watcher of watchers.values()) {
        watcher.close()
      }
      this._windowManager.closeWatcher()
      if (!isOsx) {
        app.quit()
      }
    })

    app.on('activate', () => {
      // macOS only
      // On OS X it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (this._windowManager.windowCount === 0) {
        this.ready()
      }
    })

    // webview 安全策略（右侧浏览器面板）：仅主编辑器窗口允许挂载面板
    // webview（src http(s) + persist:panel + 强制安全 webPreferences），
    // guest 上锁（新窗口→面板内建页 / will-navigate 拦截）、权限默认全拒、
    // 证书错误一律拒绝。实现见 main/browserPanel.ts。
    installBrowserPanelSecurity()
  }

  /**
   * Initialize main process language from preferences
   */
  private async _initializeLanguage(): Promise<void> {
    try {
      let currentLanguage = this._accessor.preferences.getItem<string>('language')

      // If no language is set, auto-detect based on the system language
      if (!currentLanguage) {
        const systemLanguage = app.getLocale()
        log.info(`System language detected: ${systemLanguage}`)

        // Supported language list (based on languages actually supported by the project)
        const supportedLanguages = [
          'en',
          'zh-CN',
          'zh-TW',
          'ja',
          'ko',
          'fr',
          'de',
          'es',
          'nl',
          'pt',
          'ru'
        ]

        // Language mapping: system language code -> application language code
        const languageMap: Record<string, string> = {
          'zh-CN': 'zh-CN',
          'zh-TW': 'zh-TW',
          'zh-HK': 'zh-TW',
          zh: 'zh-CN',
          en: 'en',
          'en-US': 'en',
          'en-GB': 'en',
          ja: 'ja',
          'ja-JP': 'ja',
          ko: 'ko',
          'ko-KR': 'ko',
          fr: 'fr',
          'fr-FR': 'fr',
          de: 'de',
          'de-DE': 'de',
          es: 'es',
          'es-ES': 'es',
          nl: 'nl',
          'nl-NL': 'nl',
          'nl-BE': 'nl',
          pt: 'pt',
          'pt-BR': 'pt',
          ru: 'ru',
          'ru-RU': 'ru'
        }

        currentLanguage = languageMap[systemLanguage] || 'en'

        // If the detected language is not in the supported list, use English
        if (!supportedLanguages.includes(currentLanguage)) {
          currentLanguage = 'en'
        }

        // Save the detected language setting
        this._accessor.preferences.setItem('language', currentLanguage)
        log.info(`Auto-detected and set language to: ${currentLanguage}`)
      }

      setLanguage(currentLanguage)
      log.info(`Main process language initialized to: ${currentLanguage}`)
    } catch (error) {
      log.error('Failed to initialize main process language:', error)
      // If an error occurs, use English as the default language
      setLanguage('en')
    }
  }

  async getScreenshotFileName(): Promise<string> {
    const screenshotFolderPath = (await this._accessor.dataCenter.getItem(
      'screenshotFolderPath'
    )) as string
    const fileName = `${dayjs().format('YYYY-MM-DD-HH-mm-ss')}-screenshot.png`
    return path.join(screenshotFolderPath, fileName)
  }

  ready = (): void => {
    const { _args: args, _openFilesCache } = this
    const { preferences, editorBufferStore, keybindings } = this._accessor

    // round18：网页面板优先接管缩放快捷键。Cmd +=/-/0 在墨记里本是「段落标题
    // 升降级」，面板展示网页时若不接管，用户按「网页放大」会改掉左侧文档的
    // 段落级别（用户报的「放大缩小的效果转移到左侧文档」）。实现见 browserPanel.ts。
    installPanelZoomKeyRouting(keybindings)

    // Initialize language settings
    const { startUpAction, defaultDirectoryToOpen, theme, language } = preferences.getAll()
    const followSystemTheme = preferences.getItem<boolean>('followSystemTheme')
    const lastOpenedFolder = preferences.getItem<string>('lastOpenedFolder')
    const lightModeTheme = preferences.getItem<string>('lightModeTheme')
    const darkModeTheme = preferences.getItem<string>('darkModeTheme')

    if (language) {
      setLanguage(language)
    }

    if (args._.length) {
      for (const pathname of args._) {
        // Ignore all unknown flags
        if (pathname.startsWith('--')) {
          continue
        }

        const info = normalizeMarkdownPath(pathname)
        if (info) {
          _openFilesCache.push(info as PathInfo)
        }
      }
    }

    // We should NOT restore the previous buffer or open a folder if the user just wants to double click to open a file
    if (_openFilesCache.length === 0) {
      // MoMark：冷启动固定进欢迎页（'restoreAll' 分支有意移除——恢复上次
      // 会话会把残留缓冲的 md 直接打开，与「打开即欢迎页」的产品预期冲突）。
      if (startUpAction === 'folder' && defaultDirectoryToOpen) {
        const info = normalizeMarkdownPath(defaultDirectoryToOpen)
        if (info) {
          _openFilesCache.unshift(info as PathInfo)
        }
      } else if (startUpAction === 'openLastFolder' && lastOpenedFolder) {
        const info = normalizeMarkdownPath(lastOpenedFolder)
        if (info) {
          _openFilesCache.unshift(info as PathInfo)
        }
      }
    }

    nativeTheme.themeSource = getNativeThemeSource({ followSystemTheme, theme })

    // Apply theme at startup if "Follow system theme" is enabled
    const isDarkTheme = isDarkApplicationTheme(theme)
    const systemIsDark = nativeTheme.shouldUseDarkColors

    if (followSystemTheme && isDarkTheme !== systemIsDark) {
      const newTheme = systemIsDark ? darkModeTheme : lightModeTheme
      log.info(
        `Following system theme at startup: ${newTheme} (system ${systemIsDark ? 'dark' : 'light'})`
      )
      selectTheme(newTheme)
    }

    onInternalChannel('broadcast-preferences-changed', (change: Partial<IUserPreferences>) => {
      const nextPreferences = {
        ...preferences.getAll(),
        ...change
      }
      nativeTheme.themeSource = getNativeThemeSource(nextPreferences)

      // When followSystemTheme is enabled, immediately switch to match system
      if (change.followSystemTheme === true) {
        const systemIsDark = nativeTheme.shouldUseDarkColors
        const lightModeTheme = preferences.getItem<string>('lightModeTheme')
        const darkModeTheme = preferences.getItem<string>('darkModeTheme')
        const newTheme = systemIsDark ? darkModeTheme : lightModeTheme

        log.info(
          `followSystemTheme enabled, switching to: ${newTheme} (system ${systemIsDark ? 'dark' : 'light'})`
        )
        selectTheme(newTheme)
        preferences.setItem('theme', newTheme)
      }
      // When light/dark mode theme preferences change, apply immediately if following system
      if (
        preferences.getItem<boolean>('followSystemTheme') &&
        (change.lightModeTheme || change.darkModeTheme)
      ) {
        const systemIsDark = nativeTheme.shouldUseDarkColors

        // Get current values, but prefer the NEW values from the change event
        let lightModeTheme = preferences.getItem<string>('lightModeTheme')
        let darkModeTheme = preferences.getItem<string>('darkModeTheme')

        // If these preferences were just changed, use the new values from the change object
        if (change.lightModeTheme !== undefined) {
          lightModeTheme = change.lightModeTheme
        }
        if (change.darkModeTheme !== undefined) {
          darkModeTheme = change.darkModeTheme
        }

        const newTheme = systemIsDark ? darkModeTheme : lightModeTheme

        log.info(`Theme preference changed, applying: ${newTheme}`)
        selectTheme(newTheme)
        preferences.setItem('theme', newTheme)
      }
    })

    // Listen for system theme changes and auto-switch if enabled
    if (!this._themeListenerRegistered) {
      nativeTheme.on('updated', () => {
        const followSystemTheme = preferences.getItem<boolean>('followSystemTheme')
        const lightModeTheme = preferences.getItem<string>('lightModeTheme')
        const darkModeTheme = preferences.getItem<string>('darkModeTheme')

        if (followSystemTheme) {
          const systemIsDark = nativeTheme.shouldUseDarkColors
          const newTheme = systemIsDark ? darkModeTheme : lightModeTheme
          const currentTheme = preferences.getItem<string>('theme')

          // Only switch if the theme actually needs to change
          if (newTheme !== currentTheme) {
            log.info(
              `System theme changed, switching to: ${newTheme} (system ${systemIsDark ? 'dark' : 'light'})`
            )
            selectTheme(newTheme)
            preferences.setItem('theme', newTheme)
          }
        }
      })
      this._themeListenerRegistered = true
    }

    if (isOsx) {
      app.dock?.setMenu(dockMenu)
    } else if (isWindows) {
      app.setJumpList([
        {
          type: 'recent'
        },
        {
          type: 'tasks',
          items: [
            {
              type: 'task',
              title: 'New Window',
              description: 'Opens a new window',
              program: process.execPath,
              args: '--new-window',
              iconPath: process.execPath,
              iconIndex: 0
            }
          ]
        }
      ])
    }

    const createWindow = (): void => {
      if (_openFilesCache.length) {
        // We should wipe the buffer store if not it will keep creating new windows whenever we open files via double click in the file manager
        editorBufferStore.clearBufferStoresWithAllSaved()
        this._openFilesToOpen()
      } else {
        // No content to open (blank start-up): welcome window.
        this._createWelcomeWindow()
      }
    }

    if (isLinux) {
      let windowCreated = false

      const createWindowOnce = (): void => {
        if (windowCreated) return
        windowCreated = true
        createWindow()
      }

      // Wait for theme to settle (Linux-specific issue?)
      nativeTheme.once('updated', createWindowOnce)
      // Fallback timeout in case 'updated' never fires (no theme change)
      setTimeout(createWindowOnce, 150)
    } else {
      // Create immediately on Windows/macOS
      createWindow()
    }

    // this.shortcutCapture = new ShortcutCapture()
    // if (process.env.NODE_ENV === 'development') {
    //   this.shortcutCapture.dirname = path.resolve(path.join(__dirname, '../../../node_modules/shortcut-capture'))
    // }
    // this.shortcutCapture.on('capture', async ({ dataURL }) => {
    //   const { screenshotFileName } = this
    //   const image = nativeImage.createFromDataURL(dataURL)
    //   const bufferImage = image.toPNG()

    //   if (this.launchScreenshotWin) {
    //     this.launchScreenshotWin.webContents.send('mt::screenshot-captured')
    //     this.launchScreenshotWin = null
    //   }

    //   try {
    //     // write screenshot image into screenshot folder.
    //     await fse.writeFile(screenshotFileName, bufferImage)
    //   } catch (err) {
    //     log.error(err)
    //   }
    // })
  }

  openFile = (event: Electron.Event, pathname: string): void => {
    event.preventDefault()
    log.info('[open-file] 系统请求打开:', pathname)
    const info = normalizeMarkdownPath(pathname)
    if (info) {
      this._openFilesCache.push(info as PathInfo)

      if (app.isReady()) {
        // It might come more files
        if (this._openFilesTimer) {
          clearTimeout(this._openFilesTimer)
        }
        this._openFilesTimer = setTimeout(() => {
          this._openFilesTimer = null
          this._openFilesToOpen()
        }, 100)
      }
    }
  }

  // --- private --------------------------------

  /**
   * Creates a new editor window.
   */
  private _createEditorWindow(
    rootDirectory: string | null = null,
    fileList: string[] = [],
    markdownList: string[] = [],
    options: Partial<BrowserWindowConstructorOptions> = {},
    bufferStoreInfo: { id: string; filePath: string | null } | null = null
  ): EditorWindow {
    const editor = new EditorWindow(this._accessor)
    if (rootDirectory) {
      this._accessor.preferences.setItems({ lastOpenedFolder: rootDirectory })
    }
    editor.createWindow(rootDirectory, fileList, markdownList, options, bufferStoreInfo)
    this._windowManager.add(editor)
    if (this._windowManager.windowCount === 1) {
      this._accessor.menu.setActiveWindow(editor.id!)
    }
    return editor
  }

  /**
   * Create a new setting window.
   */
  private _createSettingWindow(category?: string | null): void {
    const setting = new SettingWindow(this._accessor)
    setting.createWindow(category ?? null)
    this._windowManager.add(setting)
    if (this._windowManager.windowCount === 1) {
      this._accessor.menu.setActiveWindow(setting.id!)
    }
  }

  /**
   * Create the welcome window shown when there is nothing to open at startup.
   */
  private _createWelcomeWindow(): void {
    const welcome = new WelcomeWindow(this._accessor)
    welcome.createWindow()
    this._windowManager.add(welcome)
    if (this._windowManager.windowCount === 1) {
      this._accessor.menu.setActiveWindow(welcome.id!)
    }
  }

  /**
   * Open the about window, reusing an existing instance when present.
   */
  private _openAboutWindow(): void {
    const aboutWins = this._windowManager.getWindowsByType(WindowType.ABOUT)
    if (aboutWins.length >= 1) {
      const browserAboutWindow = aboutWins[0].win.browserWindow!
      if (isLinux) {
        browserAboutWindow.focus()
      } else {
        browserAboutWindow.moveTop()
      }
      return
    }
    const about = new AboutWindow(this._accessor)
    about.createWindow()
    this._windowManager.add(about)
    if (this._windowManager.windowCount === 1) {
      this._accessor.menu.setActiveWindow(about.id!)
    }
  }

  /**
   * Close every open welcome window (after an entry action spawned editors).
   */
  private _closeWelcomeWindows(): void {
    for (const { win } of this._windowManager.getWindowsByType(WindowType.WELCOME)) {
      this._windowManager.forceCloseById(win.id as number)
    }
  }

  /**
   * Resolve a window id to an editor window only; non-editor windows
   * (welcome/about) must never be cast for editor-side methods.
   */
  private _getEditorWindowById(windowId: number): EditorWindow | undefined {
    const win = this._windowManager.get(windowId)
    return win && win.type === WindowType.EDITOR ? (win as EditorWindow) : undefined
  }

  /**
   * Recent documents for the welcome window: existing paths only, newest first.
   */
  private async _getWelcomeRecents(): Promise<
    Array<{ path: string; name: string; dirname: string; mtime: number }>
  > {
    // macOS 上菜单层从不写 recently-used-documents.json（addRecentlyUsedDocument
    // 只调用系统 app.addRecentDocument 后即返回），getRecentlyUsedDocuments 永远为空，
    // 导致欢迎页/文档面板的「最近打开」列表空无一物。
    // 兜底：读取系统最近文档清单（app.getRecentDocuments），过滤仍存在的文件。
    let recents = this._accessor.menu.getRecentlyUsedDocuments()
    if (recents.length === 0 && isOsx) {
      recents = (app.getRecentDocuments() as string[]).filter((f) => {
        if (!f) return false
        try {
          return isFile2(f)
        } catch {
          return false
        }
      })
    }
    const items: Array<{ path: string; name: string; dirname: string; mtime: number }> = []
    for (const filePath of recents.slice(0, 8)) {
      try {
        const stat = await fsPromises.stat(filePath)
        items.push({
          path: filePath,
          name: path.basename(filePath),
          dirname: path.dirname(filePath),
          mtime: stat.mtimeMs
        })
      } catch {
        // The file was deleted since it was recorded; skip it.
      }
    }
    return items
  }

  private _openFilesToOpen(): void {
    this._openPathList(this._openFilesCache, false)
  }

  /**
   * Open the path list in the best window(s).
   *
   * @param pathsToOpen The path list to open.
   * @param openFilesInSameWindow Open all files in the same window with
   * the first directory and discard other directories.
   */
  private _openPathList(pathsToOpen: PathInfo[], openFilesInSameWindow: boolean = false): void {
    const { _windowManager } = this
    const openFilesInNewWindow = this._accessor.preferences.getItem<boolean>('openFilesInNewWindow')

    const fileSet = new Set<string>()
    const directorySet = new Set<string>()
    for (const { isDir, path } of pathsToOpen) {
      if (isDir) {
        directorySet.add(path)
      } else {
        fileSet.add(path)
      }
    }

    // Filter out directories that are already opened.
    for (const window of _windowManager.windows.values()) {
      if (window.type === WindowType.EDITOR) {
        const { openedRootDirectory } = window as EditorWindow
        if (openedRootDirectory && directorySet.has(openedRootDirectory)) {
          window.bringToFront()
          directorySet.delete(openedRootDirectory)
        }
      }
    }

    const directoriesToOpen: { rootDirectory: string | null; fileList: string[] }[] = Array.from(
      directorySet
    ).map((dir) => ({
      rootDirectory: dir,
      fileList: []
    }))
    const filesToOpen = Array.from(fileSet)

    // Discard all directories except first one and add files.
    if (openFilesInSameWindow) {
      if (directoriesToOpen.length) {
        directoriesToOpen[0].fileList.push(...filesToOpen)
        directoriesToOpen.length = 1
      } else {
        directoriesToOpen.push({ rootDirectory: null, fileList: [...filesToOpen] })
      }
      filesToOpen.length = 0
    }

    // Find the best window(s) to open the files in.
    if (!openFilesInSameWindow && !openFilesInNewWindow) {
      const isFirstWindow = _windowManager.getActiveEditorId() === null

      // Prefer new directories
      for (let i = 0; i < directoriesToOpen.length; ++i) {
        const { fileList, rootDirectory } = directoriesToOpen[i]

        let breakOuterLoop = false
        for (let j = 0; j < filesToOpen.length; ++j) {
          const pathname = filesToOpen[j]
          if (isChildOfDirectory(rootDirectory ?? '', pathname)) {
            if (isFirstWindow) {
              fileList.push(...filesToOpen)
              filesToOpen.length = 0
              breakOuterLoop = true
              break
            }
            fileList.push(pathname)
            filesToOpen.splice(j, 1)
            --j
          }
        }

        if (breakOuterLoop) {
          break
        }
      }

      // Find for the remaining files the best window to open the files in.
      if (isFirstWindow && directoriesToOpen.length && filesToOpen.length) {
        const { fileList } = directoriesToOpen[0]
        fileList.push(...filesToOpen)
        filesToOpen.length = 0
      } else {
        const windowList = _windowManager.findBestWindowToOpenIn(filesToOpen)
        for (const item of windowList) {
          const { windowId, fileList } = item

          // 已打开的文件现在会回到它所在的窗口，理论上这里不会再出现空列表；
          // 真出现说明既打不开也定位不到窗口，至少要留痕并激活窗口，
          // 绝不能像以前那样静默地什么都不做。
          if (fileList.length === 0) {
            log.warn('[open-path] 没有可打开的文件，改为激活当前窗口')
            const activeWindow = _windowManager.getActiveWindow()
            activeWindow?.bringToFront()
            continue
          }

          if (windowId !== null) {
            const window = _windowManager.get(windowId) as EditorWindow | undefined
            if (window) {
              window.openTabsFromPaths(fileList)
              window.bringToFront()
              continue
            }
            // else: fallthrough
          }
          this._createEditorWindow(null, fileList)
        }
      }

      // Directores are always opened in a new window if not already opened.
      for (const item of directoriesToOpen) {
        const { rootDirectory, fileList } = item
        this._createEditorWindow(rootDirectory, fileList)
      }
    } else {
      // Open each file and directory in a new window.

      for (const pathname of filesToOpen) {
        this._createEditorWindow(null, [pathname])
      }

      for (const item of directoriesToOpen) {
        const { rootDirectory, fileList } = item
        this._createEditorWindow(rootDirectory, fileList)
      }
    }

    // 外部打开（Finder/CLI/second-instance）落位到编辑器窗口后，收掉遗留的
    // 欢迎窗——欢迎窗只在欢迎页自身入口动作里自关，外部打开文件时不应残留
    // 成“第二个应用”。
    if (_windowManager.getActiveEditorId() !== null) {
      this._closeWelcomeWindows()
    }

    // Empty the file list
    pathsToOpen.length = 0
  }

  private _openSettingsWindow(category?: string | null): void {
    const settingWins = this._windowManager.getWindowsByType(WindowType.SETTINGS)
    if (settingWins.length >= 1) {
      // A setting window is already created
      const browserSettingWindow = settingWins[0].win.browserWindow!
      browserSettingWindow.webContents.send('settings::change-tab', category)
      if (isLinux) {
        browserSettingWindow.focus()
      } else {
        browserSettingWindow.moveTop()
      }
      return
    }
    this._createSettingWindow(category)
  }

  private _listenForIpcMain(): void {
    registerKeyboardListeners()
    registerSpellcheckerListeners()

    // Handle language setting requests
    ipcMain.on('mt::get-current-language', (event) => {
      const { language } = this._accessor.preferences.getAll()
      event.reply('mt::current-language', language || 'en')
    })

    ipcMain.on('app-create-editor-window', () => {
      this._createEditorWindow()
    })

    ipcMain.on('app-create-about-window', () => {
      this._openAboutWindow()
    })

    // --- welcome window ---------------------------------------------------

    // Entry action: open a blank document in a fresh editor window.
    ipcMain.on('mt::welcome::new-doc', () => {
      this._createEditorWindow()
      this._closeWelcomeWindows()
    })

    // Entry action: pick markdown file(s) via the system dialog.
    ipcMain.on('mt::welcome::open-file', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return
      }
      dialog
        .showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: t('menu.file.openFile'), extensions: [...MARKDOWN_EXTENSIONS] }]
        })
        .then(({ filePaths }) => {
          if (Array.isArray(filePaths) && filePaths.length > 0) {
            for (const filePath of filePaths) {
              this._createEditorWindow(null, [normalizeAndResolvePath(filePath)])
            }
            this._closeWelcomeWindows()
          }
        })
        .catch((err) => {
          log.error('Error on opening file dialog:', err)
        })
    })

    // Entry action: pick a folder via the system dialog (always a new window).
    ipcMain.on('mt::welcome::open-folder', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return
      }
      dialog
        .showOpenDialog(win, {
          properties: ['openDirectory', 'createDirectory']
        })
        .then(({ filePaths }) => {
          const filePath = filePaths && filePaths[0]
          if (filePath) {
            this._createEditorWindow(normalizeAndResolvePath(filePath))
            this._closeWelcomeWindows()
          }
        })
        .catch((err) => {
          log.error('Error on opening directory dialog:', err)
        })
    })

    // Click on a recent document: open it in a fresh editor window.
    ipcMain.on('mt::welcome::open-recent', (event, filePath: string) => {
      const resolvedPath = normalizeAndResolvePath(filePath)
      const info = normalizeMarkdownPath(resolvedPath)
      if (info) {
        this._createEditorWindow(null, [info.path])
        this._closeWelcomeWindows()
      } else {
        log.error(`Cannot open unknown file: "${filePath}"`)
      }
    })

    ipcMain.handle('mt::welcome::recents', () => this._getWelcomeRecents())

    onInternalChannel('screen-capture', async (win: BrowserWindow) => {
      if (isOsx) {
        // Use macOs `screencapture` command line when in macOs system.
        const screenshotFileName = await this.getScreenshotFileName()
        exec('screencapture -i -c', async (err) => {
          if (err) {
            log.error(err)
            return
          }
          // The renderer can no longer paste the clipboard bitmap via the
          // removed `document.execCommand('paste')`, so persist the capture to a
          // PNG and hand the path to the renderer to insert at the cursor.
          let savedPath = ''
          try {
            const image = clipboard.readImage()
            // `screencapture` leaves the clipboard untouched when the user
            // cancels (Esc); skip so we don't insert a stale/empty image.
            if (!image.isEmpty()) {
              const bufferImage = image.toPNG()
              await fsPromises.writeFile(screenshotFileName, bufferImage)
              savedPath = screenshotFileName
            }
          } catch (writeErr) {
            log.error(writeErr)
          }
          win.webContents.send('mt::screenshot-captured', savedPath)
        })
      } else {
        // TODO: Do nothing, maybe we'll add screenCapture later on Linux and Windows.
        // if (this.shortcutCapture) {
        //   this.launchScreenshotWin = win
        //   this.shortcutCapture.shortcutCapture()
        // }
      }
    })

    onInternalChannel('app-create-settings-window', (category?: string) => {
      this._openSettingsWindow(category)
    })

    onInternalChannel('app-open-file-by-id', (windowId: number, filePath: string) => {
      const openFilesInNewWindow =
        this._accessor.preferences.getItem<boolean>('openFilesInNewWindow')
      if (openFilesInNewWindow) {
        this._createEditorWindow(null, [filePath])
      } else {
        const editor = this._getEditorWindowById(windowId)
        if (editor) {
          editor.openTab(filePath, {}, true)
        } else {
          // The focused window is not an editor (e.g. welcome/about): open a new one.
          this._createEditorWindow(null, [filePath])
        }
      }
    })
    onInternalChannel('app-open-files-by-id', (windowId: number, fileList: string[]) => {
      const openFilesInNewWindow =
        this._accessor.preferences.getItem<boolean>('openFilesInNewWindow')
      if (openFilesInNewWindow) {
        this._createEditorWindow(null, fileList)
      } else {
        const editor = this._getEditorWindowById(windowId)
        if (editor) {
          editor.openTabsFromPaths(
            fileList
              .map((p) => normalizeMarkdownPath(p))
              .filter((i): i is PathInfo => i !== null && !i.isDir)
              .map((i) => i.path)
          )
        } else {
          this._createEditorWindow(null, fileList)
        }
      }
    })

    onInternalChannel('app-open-markdown-by-id', (windowId: number, data: string) => {
      const openFilesInNewWindow =
        this._accessor.preferences.getItem<boolean>('openFilesInNewWindow')
      if (openFilesInNewWindow) {
        this._createEditorWindow(null, [], [data])
      } else {
        const editor = this._getEditorWindowById(windowId)
        if (editor) {
          editor.openUntitledTab(true, data)
        } else {
          this._createEditorWindow(null, [], [data])
        }
      }
    })

    onInternalChannel(
      'app-open-directory-by-id',
      (windowId: number, pathname: string, openInSameWindow: boolean) => {
        const { openFolderInNewWindow } = this._accessor.preferences.getAll()
        if (openInSameWindow || !openFolderInNewWindow) {
          const editor = this._getEditorWindowById(windowId)
          if (editor) {
            editor.openFolder(pathname)
            return
          }
        }
        this._createEditorWindow(pathname)
      }
    )

    // --- renderer -------------------

    ipcMain.on('mt::app-try-quit', () => {
      app.quit()
    })

    ipcMain.on('mt::open-file-by-window-id', (_e, windowId: number, filePath: string) => {
      const resolvedPath = normalizeAndResolvePath(filePath)
      const openFilesInNewWindow =
        this._accessor.preferences.getItem<boolean>('openFilesInNewWindow')
      if (openFilesInNewWindow) {
        this._createEditorWindow(null, [resolvedPath])
      } else {
        const editor = this._getEditorWindowById(windowId)
        if (editor) {
          editor.openTab(resolvedPath, {}, true)
        }
      }
    })

    ipcMain.on('mt::select-default-directory-to-open', async (e) => {
      const { preferences } = this._accessor
      const { defaultDirectoryToOpen } = preferences.getAll()
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return

      const { filePaths } = await dialog.showOpenDialog(win, {
        defaultPath: defaultDirectoryToOpen,
        properties: ['openDirectory', 'createDirectory']
      })
      if (filePaths && filePaths[0]) {
        preferences.setItems({ defaultDirectoryToOpen: filePaths[0] })
      }
    })

    ipcMain.on('mt::open-setting-window', () => {
      this._openSettingsWindow()
    })

    ipcMain.on('mt::make-screenshot', (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      ipcMain.emit('screen-capture', win)
    })

    ipcMain.on('mt::request-keybindings', (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return
      const { keybindings } = this._accessor
      // Convert map to object
      win.webContents.send('mt::keybindings-response', Object.fromEntries(keybindings.keys))
    })

    ipcMain.on('mt::open-keybindings-config', () => {
      const { keybindings } = this._accessor
      keybindings.openConfigInFileManager()
    })

    ipcMain.handle('mt::keybinding-get-pref-keybindings', () => {
      const { keybindings } = this._accessor
      const defaultKeybindings = keybindings.getDefaultKeybindings()
      const userKeybindings = keybindings.getUserKeybindings()
      return { defaultKeybindings, userKeybindings }
    })

    ipcMain.handle('mt::keybinding-save-user-keybindings', async (_event, userKeybindings) => {
      const { keybindings, menu } = this._accessor
      const editorWindows = this._windowManager
        .getWindowsByType(WindowType.EDITOR)
        .map(({ win }) => win.browserWindow)
        .filter((win): win is BrowserWindow => win != null)
      const saved = await keybindings.setUserKeybindings(userKeybindings, editorWindows)

      menu.updateKeybindings()
      const keybindingMap = Object.fromEntries(keybindings.keys)
      for (const win of editorWindows) {
        win.webContents.send('mt::keybindings-response', keybindingMap)
      }

      return saved
    })

    ipcMain.handle('mt::fs-trash-item', async (_event, fullPath: string) => {
      return shell.trashItem(fullPath)
    })
  }
}

export default App
