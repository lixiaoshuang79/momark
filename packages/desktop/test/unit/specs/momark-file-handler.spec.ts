import { describe, it, expect, vi, beforeEach } from 'vitest'

// 协议处理器本身依赖 electron 的 protocol/net/app —— 这里 mock 掉，把注册进去的
// 处理器抓出来直接驱动：这条路径（URL → 白名单 → 读盘）是 webSecurity 打开后
// 渲染层唯一的本地图片入口，值得有单测。
const state = vi.hoisted(() => ({
  schemeDeclared: [] as unknown[],
  handlers: new Map<string, (req: { url: string }) => Promise<Response>>(),
  fetch: vi.fn(async (url: string) => new Response(`body:${url}`, { status: 200 })),
  whenReady: vi.fn(() => Promise.resolve())
}))

vi.mock('electron', () => ({
  app: { whenReady: state.whenReady, getAppPath: () => '/app', isPackaged: false },
  net: { fetch: (url: string) => state.fetch(url) },
  protocol: {
    registerSchemesAsPrivileged: (list: unknown[]) => state.schemeDeclared.push(...list),
    handle: (scheme: string, handler: (req: { url: string }) => Promise<Response>) => {
      state.handlers.set(scheme, handler)
    }
  }
}))

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn() } }))

import { MOMARK_FILE_SCHEME } from '@shared/types/momarkFile'

const { registerMomarkFileScheme, installMomarkFileProtocol, momarkFilePathToFileUrl } =
  await import('main_renderer/ipc/momarkFileProtocol')

const request = (url: string): { url: string } => ({ url })

describe('momark-file 协议注册（A-12 ①）', () => {
  beforeEach(() => {
    state.schemeDeclared.length = 0
    state.handlers.clear()
    state.fetch.mockClear()
  })

  it('scheme 以 standard + secure + supportFetchAPI 特权声明', () => {
    registerMomarkFileScheme()
    expect(state.schemeDeclared).toEqual([
      {
        scheme: MOMARK_FILE_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
      }
    ])
  })

  it('处理器的读取范围钉在图片扩展名上（非图片一律 403，不碰磁盘）', async () => {
    installMomarkFileProtocol()
    const handler = state.handlers.get(MOMARK_FILE_SCHEME)
    expect(handler).toBeTruthy()

    for (const url of [
      'momark-file://local/Users/me/.ssh/id_rsa',
      'momark-file://local/Users/me/Library/LaunchAgents/evil.plist',
      'momark-file://local/tmp/a.html',
      'file:///tmp/a.png',
      'momark-file://evil/tmp/a.png',
      'momark-file://local/tmp/a.png.js'
    ]) {
      const res = await handler!(request(url))
      expect(res.status).toBe(403)
    }
    expect(state.fetch).not.toHaveBeenCalled()
  })

  it('图片请求转成 file:// 交给 net.fetch（含中文/空格编码）', async () => {
    installMomarkFileProtocol()
    const handler = state.handlers.get(MOMARK_FILE_SCHEME)!
    const res = await handler(
      request('momark-file://local/Users/me/%E6%88%91%E7%9A%84%20%E5%9B%BE/a.png')
    )
    expect(res.status).toBe(200)
    expect(state.fetch).toHaveBeenCalledWith('file:///Users/me/我的 图/a.png')
  })

  it('读盘失败回 404（不把异常抛给协议层）', async () => {
    installMomarkFileProtocol()
    state.fetch.mockRejectedValueOnce(new Error('ENOENT'))
    const handler = state.handlers.get(MOMARK_FILE_SCHEME)!
    const res = await handler(request('momark-file://local/tmp/missing.png'))
    expect(res.status).toBe(404)
  })
})

describe('momarkFilePathToFileUrl（与引擎侧实现同形）', () => {
  it('POSIX / 盘符 / UNC 三种形态', () => {
    expect(momarkFilePathToFileUrl('/tmp/a.png')).toBe('file:///tmp/a.png')
    expect(momarkFilePathToFileUrl('C:/pics/b.png')).toBe('file:///C:/pics/b.png')
    expect(momarkFilePathToFileUrl('//server/share/c.png')).toBe('file://server/share/c.png')
  })

  it('反斜杠归一（Windows 形态）', () => {
    expect(momarkFilePathToFileUrl('C:\\pics\\b.png')).toBe('file:///C:/pics/b.png')
  })
})
