import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// F1（A-11）：`mt::shell::open-external` / `mt::shell::open-path` 是渲染层可以
// 直接喂参数的通道——恶意文档里的链接（或一次 XSS）能借它拉起任意 scheme
// handler / 执行本机文件。
//   · openExternal：只放行 http/https/mailto（外加应用自身的系统设置深链）；
//   · openPath：扩展名黑名单（补上 .terminal/.workflow/.pkg）+ 可执行位兜住
//     没有扩展名的可执行文件。

// `mt::shell::open-external` 同时注册了 handle（invoke）与 on（send）两个处理器，
// 分开收才能各自驱动。
const state = vi.hoisted(() => ({
  handled: new Map<string, (...args: unknown[]) => unknown>(),
  listened: new Map<string, (...args: unknown[]) => unknown>(),
  openExternal: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve(''))
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      state.handled.set(channel, listener)
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      state.listened.set(channel, listener)
    }
  },
  shell: { openExternal: state.openExternal, openPath: state.openPath, showItemInFolder: vi.fn() },
  clipboard: { writeText: vi.fn(), readText: () => '' }
}))

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

const { registerShellHandlers, isAllowedExternalUrl, isBlockedOpenPath } =
  await import('main_renderer/ipc/shell')
registerShellHandlers()

const invoke = async (channel: string, arg: unknown): Promise<unknown> => {
  const handler = state.handled.get(channel)
  if (!handler) throw new Error(`${channel} handler was not registered`)
  return handler({}, arg)
}

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'momark-f1-shell-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  state.openExternal.mockClear()
  state.openPath.mockClear()
})

describe('F1(A-11) — openExternal scheme 白名单', () => {
  it('放行 http / https / mailto', () => {
    for (const url of [
      'https://momark.app',
      'http://example.com/a?b=1',
      'mailto:someone@example.com'
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(true)
    }
  })

  it('拒绝其它 scheme 与垃圾输入', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'vbscript:msgbox(1)',
      'smb://host/share',
      'x-apple.systempreferences:com.apple.preference.other',
      'not a url',
      '',
      undefined,
      null
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(false)
    }
  })

  it('保留应用自身的系统设置深链（Chrome 登录态导入的 FDA 引导）', () => {
    expect(
      isAllowedExternalUrl(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
      )
    ).toBe(true)
  })

  it('处理器层面拦截：被拒的 URL 不会到达 shell.openExternal', async () => {
    expect(await invoke('mt::shell::open-external', 'javascript:alert(1)')).toBe(false)
    expect(state.openExternal).not.toHaveBeenCalled()

    expect(await invoke('mt::shell::open-external', 'https://momark.app')).toBe(true)
    expect(state.openExternal).toHaveBeenCalledWith('https://momark.app')
  })

  it('fire-and-forget 通道（ipcMain.on）同样拦截', () => {
    const onHandler = state.listened.get('mt::shell::open-external')
    expect(onHandler).toBeTruthy()

    onHandler!({}, 'file:///etc/passwd')
    expect(state.openExternal).not.toHaveBeenCalled()

    onHandler!({}, 'https://momark.app')
    expect(state.openExternal).toHaveBeenCalledWith('https://momark.app')
  })
})

describe('F1(A-11) — openPath 拒绝可执行文件', () => {
  it('扩展名黑名单补上了 .terminal / .workflow / .pkg', () => {
    for (const name of ['deploy.terminal', 'build.workflow', 'installer.pkg']) {
      expect(isBlockedOpenPath(`/tmp/${name}`)).toBe(true)
    }
  })

  it('无扩展名但有可执行位的文件也拒绝', () => {
    const dir = tempDir()
    const script = path.join(dir, 'deploy')
    writeFileSync(script, '#!/bin/sh\n', 'utf-8')
    chmodSync(script, 0o755)
    expect(isBlockedOpenPath(script)).toBe(true)
  })

  it('普通文件与目录放行（目录是「打开访达」）', () => {
    const dir = tempDir()
    const doc = path.join(dir, 'note.md')
    writeFileSync(doc, '# hi', 'utf-8')
    expect(isBlockedOpenPath(doc)).toBe(false)
    expect(isBlockedOpenPath(dir)).toBe(false)
    expect(isBlockedOpenPath(path.join(dir, 'does-not-exist.md'))).toBe(false)
  })

  it('处理器层面拦截：可执行文件不会到达 shell.openPath', async () => {
    const dir = tempDir()
    const script = path.join(dir, 'run.sh')
    writeFileSync(script, '#!/bin/sh\n', 'utf-8')
    chmodSync(script, 0o755)

    const result = await invoke('mt::shell::open-path', script)
    expect(String(result)).not.toBe('')
    expect(state.openPath).not.toHaveBeenCalled()

    const doc = path.join(dir, 'note.md')
    writeFileSync(doc, '# hi', 'utf-8')
    await invoke('mt::shell::open-path', doc)
    expect(state.openPath).toHaveBeenCalledWith(doc)
  })
})
