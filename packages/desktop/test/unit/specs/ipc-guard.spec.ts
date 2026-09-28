import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'

// guard.ts 只用到 electron 的 BrowserWindow / app / ipcMain 三个面；这里按需
// mock（与 test/unit/specs 里既有的 electron mock 同风格）。
const state = vi.hoisted(() => ({
  windowFor: null as null | ((wc: unknown) => unknown),
  appPath: '/Applications/墨记.app/Contents/Resources/app.asar',
  resourcesPath: '/Applications/墨记.app/Contents/Resources'
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (wc: unknown) => (state.windowFor ? state.windowFor(wc) : null)
  },
  app: {
    getAppPath: () => state.appPath
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

vi.mock('electron-log', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

const { isDeniedWritePath, isTrustedIpcSender, checkWritePaths } =
  await import('main_renderer/ipc/guard')

const home = os.homedir()

// ── ③ senderFrame 来源校验 ────────────────────────────────────────────
describe('isTrustedIpcSender（A-12 ③）', () => {
  const mainFrame = { parent: null, url: 'file:///app/out/renderer/index.html' }
  const subFrame = { parent: {}, url: 'about:blank' }

  beforeEach(() => {
    state.windowFor = () => ({ isDestroyed: () => false })
  })

  it('自家窗口的主 frame → 放行', () => {
    expect(isTrustedIpcSender({ senderFrame: mainFrame, sender: {} } as never)).toBe(true)
  })

  it('子 frame（srcdoc / 沙箱帧）→ 拒绝', () => {
    expect(isTrustedIpcSender({ senderFrame: subFrame, sender: {} } as never)).toBe(false)
  })

  it('拿不到 senderFrame（frame 已销毁）→ 拒绝', () => {
    expect(isTrustedIpcSender({ senderFrame: null, sender: {} } as never)).toBe(false)
  })

  it('webview guest（不是 BrowserWindow）→ 拒绝', () => {
    state.windowFor = () => null
    expect(isTrustedIpcSender({ senderFrame: mainFrame, sender: {} } as never)).toBe(false)
  })

  it('窗口正在销毁 → 拒绝', () => {
    state.windowFor = () => ({ isDestroyed: () => true })
    expect(isTrustedIpcSender({ senderFrame: mainFrame, sender: {} } as never)).toBe(false)
  })
})

// ── ④ 写路径护栏（最小可行版本）──────────────────────────────────────
describe('isDeniedWritePath（A-12 ④）', () => {
  it('拦住 macOS 持久化目录', () => {
    expect(isDeniedWritePath(path.join(home, 'Library/LaunchAgents/evil.plist'))).toBe(true)
    expect(isDeniedWritePath(path.join(home, 'Library/LaunchDaemons/evil.plist'))).toBe(true)
    expect(isDeniedWritePath('/Library/LaunchAgents/evil.plist')).toBe(true)
  })

  it('拦住登录 shell 启动脚本（同样是持久化入口）', () => {
    expect(isDeniedWritePath(path.join(home, '.zshrc'))).toBe(true)
    expect(isDeniedWritePath(path.join(home, '.bash_profile'))).toBe(true)
  })

  it('拦住凭据目录', () => {
    expect(isDeniedWritePath(path.join(home, '.ssh/authorized_keys'))).toBe(true)
    expect(isDeniedWritePath(path.join(home, '.aws/credentials'))).toBe(true)
  })

  it('拦住应用自身（自篡改）', () => {
    expect(isDeniedWritePath(path.join(state.appPath, 'out/main/index.js'))).toBe(true)
    expect(isDeniedWritePath(path.join(state.resourcesPath, 'app.asar'))).toBe(true)
  })

  it('放行正常写作路径（用户目录 / 临时目录）', () => {
    for (const p of [
      path.join(home, 'Documents/notes/a.md'),
      path.join(home, 'Desktop/图.png'),
      '/tmp/momark-upload/a.png',
      path.join(home, 'Library/Application Support/墨记/config.json')
    ]) {
      expect(isDeniedWritePath(p)).toBe(false)
    }
  })

  it('`/Users/…` 不会被 `/usr` 前缀误伤（大小写不敏感也不误伤）', () => {
    expect(isDeniedWritePath('/Users/someone/x.md')).toBe(false)
  })

  it('非法入参一律拒绝（非字符串 / 空 / 带 NUL）', () => {
    expect(isDeniedWritePath(undefined)).toBe(true)
    expect(isDeniedWritePath('')).toBe(true)
    expect(isDeniedWritePath('/tmp/a\0.png')).toBe(true)
  })

  it('尾斜杠 / 相对形态的同一路径判定一致', () => {
    const target = path.join(home, 'Library/LaunchAgents')
    expect(isDeniedWritePath(target)).toBe(true)
    expect(isDeniedWritePath(`${target}/`)).toBe(true)
    expect(isDeniedWritePath(`${target}/../LaunchAgents/x.plist`)).toBe(true)
  })

  it('checkWritePaths：任一命中即返回该路径，全过返回 null', () => {
    expect(checkWritePaths('/tmp/a.png', '/tmp/b.png')).toBeNull()
    expect(checkWritePaths('/tmp/a.png', path.join(home, '.zshrc'))).toBe(path.join(home, '.zshrc'))
    // undefined/null 槽位跳过（例如 move 的缺省 dest）
    expect(checkWritePaths('/tmp/a.png', undefined)).toBeNull()
  })
})
