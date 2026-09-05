import path from 'path'
import { BrowserWindow, ipcMain } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import BaseWindow, { WindowLifecycle, WindowType } from './base'
import type Accessor from '../app/accessor'
import { aboutWinOptions, isLinux } from '../config'
import log from 'electron-log'

/**
 * MoMark about window (PHASE2-SPEC §9): 420×480pt, frozen icon-1 (92px, 21px
 * corner radius), name, version and MIT license line.
 */
class AboutWindow extends BaseWindow {
  /**
   * @param accessor The application accessor for application instances.
   */
  constructor(accessor: Accessor) {
    super(accessor)
    this.type = WindowType.ABOUT
  }

  createWindow(): BrowserWindow {
    const { env, preferences } = this._accessor
    const winOptions: BrowserWindowConstructorOptions = Object.assign({}, aboutWinOptions)

    if (isLinux) {
      winOptions.icon = path.join(
        (global as unknown as { __static: string }).__static,
        'logo-96px.png'
      )
    }

    const { theme } = preferences.getAll()
    winOptions.backgroundColor = this._getPreferredBackgroundColor(theme)
    let win: BrowserWindow | null = (this.browserWindow = new BrowserWindow(winOptions))

    win.webContents.on('did-fail-load', (_event, code, desc, url) => {
      log.error(`did-fail-load ${code} ${desc} @ ${url}`)
    })

    win.webContents.on('render-process-gone', (_event, details) => {
      log.error(`render-process-gone: ${details.reason} (${details.exitCode})`)
    })

    this.id = win.id

    win.once('ready-to-show', () => {
      this.lifecycle = WindowLifecycle.READY
      this.emit('window-ready')
    })

    win.on('focus', () => {
      this.emit('window-focus')
      win!.webContents.send('mt::window-active-status', { status: true })
    })

    win.on('blur', () => {
      this.emit('window-blur')
      win!.webContents.send('mt::window-active-status', { status: false })
    })

    win.on('close', (event) => {
      this.emit('window-close')

      event.preventDefault()
      ipcMain.emit('window-close-by-id', win!.id)
    })

    win.on('closed', () => {
      this.emit('window-closed')

      // Free window reference
      win = null
    })

    this.lifecycle = WindowLifecycle.LOADING
    win.loadURL(this._buildUrlString(this.id, env, preferences))
    return win
  }
}

export default AboutWindow
