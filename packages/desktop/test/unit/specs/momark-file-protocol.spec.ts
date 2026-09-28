import { describe, it, expect } from 'vitest'

// 协议 URL 的构造/解析是纯字符串 + WHATWG URL 运算，不碰 electron —— 直接测
// `@shared/types/momarkFile`，不需要 mock 运行时。
import {
  MOMARK_FILE_SCHEME,
  isAllowedMomarkFileExtension,
  momarkFileUrlToPath,
  pathToMomarkFileUrl
} from '@shared/types/momarkFile'

// 与引擎侧 `muya/src/utils/image.ts#localPathToMomarkUrl` 的格式约定：
// `momark-file://local/<逐段编码的绝对路径>[?query][#fragment]`。
// 两边各有一组单测钉住格式，改一边就会有两边红。
describe('momark-file 协议 URL 构造（A-12 ①）', () => {
  it('POSIX 绝对路径 → 协议 URL（三段斜杠形态稳定）', () => {
    expect(pathToMomarkFileUrl('/Users/me/docs/a.png')).toBe(
      'momark-file://local/Users/me/docs/a.png'
    )
  })

  it('空格 / 中文逐段编码，`/` 保留为分隔符', () => {
    expect(pathToMomarkFileUrl('/Users/me/我的 图片/a.png')).toBe(
      'momark-file://local/Users/me/%E6%88%91%E7%9A%84%20%E5%9B%BE%E7%89%87/a.png'
    )
  })

  it('Windows 盘符路径写成 /C%3A/…（解析回来仍是 C:/…）', () => {
    const url = pathToMomarkFileUrl('C:\\pics\\b.png')
    expect(url).toBe('momark-file://local/C%3A/pics/b.png')
    expect(momarkFileUrlToPath(url)).toBe('C:/pics/b.png')
  })

  it('查询串/片段按原样透传（与 file:// 的语义一致：只影响 URL 身份）', () => {
    expect(pathToMomarkFileUrl('/tmp/b.png?v=2')).toBe('momark-file://local/tmp/b.png?v=2')
    const url = pathToMomarkFileUrl('/tmp/b.png#frag')
    expect(url).toBe('momark-file://local/tmp/b.png#frag')
    // 解析时 query / fragment 不参与路径
    expect(momarkFileUrlToPath(url)).toBe('/tmp/b.png')
  })
})

describe('momark-file 协议 URL 解析（A-12 ①）', () => {
  it('往返（相对编码无关）：构造 → 解析回到原路径', () => {
    const paths = [
      '/Users/me/docs/a.png',
      '/Users/me/我的 图片/a.png',
      '/tmp/with space/a b.png',
      '/a/b/c/d/e/f/g.jpg'
    ]
    for (const p of paths) {
      expect(momarkFileUrlToPath(pathToMomarkFileUrl(p))).toBe(p)
    }
  })

  it('路径里含 `#` 时按片段处理（与 file:// 同语义，是既有约定不是本协议新增）', () => {
    // `file:///tmp/a#b.png` 里的 `#b.png` 同样是 fragment —— 迁移前后一致。
    const url = pathToMomarkFileUrl('/tmp/a#b.png')
    expect(url).toBe('momark-file://local/tmp/a#b.png')
    expect(momarkFileUrlToPath(url)).toBe('/tmp/a')
  })

  it('UNC 路径：host 位置留空、真实 host 进 pathname（与引擎侧实现同形）', () => {
    // 引擎把 `\\server\share\a.png` 解析成 `//server/share/a.png`，编码后是
    // `momark-file://local//server/share/a.png`（host 恒为 local）。
    const url = 'momark-file://local//server/share/a.png'
    expect(momarkFileUrlToPath(url)).toBe('//server/share/a.png')
    // 处理器侧再把它还原成 host 形式的 file:// 读取地址（见 momarkFileProtocol）
    expect(url.startsWith('momark-file://local//')).toBe(true)
  })

  it('拒绝别的 scheme', () => {
    expect(momarkFileUrlToPath('file:///tmp/a.png')).toBeNull()
    expect(momarkFileUrlToPath('https://example.com/a.png')).toBeNull()
  })

  it('拒绝别的 host（只认固定 host `local`）', () => {
    expect(momarkFileUrlToPath('momark-file://evil/tmp/a.png')).toBeNull()
  })

  it('拒绝非法 URL / 空值', () => {
    expect(momarkFileUrlToPath('')).toBeNull()
    expect(momarkFileUrlToPath('not a url')).toBeNull()
  })

  it('根路径解析得出来，但会被扩展名白名单拒掉（不是可读文件）', () => {
    const root = momarkFileUrlToPath('momark-file://local/')
    expect(root).toBe('/')
    expect(isAllowedMomarkFileExtension(root as string)).toBe(false)
  })

  it('拒绝带 NUL 字节的路径（编码后的 %00 也不行）', () => {
    expect(momarkFileUrlToPath('momark-file://local/tmp/a%00.png')).toBeNull()
  })

  it('拒绝畸形百分号编码（decodeURIComponent 抛错）', () => {
    expect(momarkFileUrlToPath('momark-file://local/tmp/%E0%A4%A.png')).toBeNull()
  })
})

describe('momark-file 读取白名单（只放行图片扩展名）', () => {
  it('放行常见图片扩展名（大小写不敏感）', () => {
    for (const p of ['a.png', 'a.PNG', 'a.jpeg', 'a.JPG', 'a.jpg', 'a.gif', 'a.svg', 'a.webp']) {
      expect(isAllowedMomarkFileExtension(p)).toBe(true)
    }
  })

  it('拒绝非图片（协议不是任意文件读取通道）', () => {
    for (const p of [
      '/Users/me/.ssh/id_rsa',
      '/Users/me/Library/LaunchAgents/evil.plist',
      '/tmp/a.html',
      '/tmp/a.js',
      '/tmp/a',
      '/tmp/.png',
      '/tmp/a.png.js',
      ''
    ]) {
      expect(isAllowedMomarkFileExtension(p)).toBe(false)
    }
  })

  it('路径尾部的 query/fragment 不影响扩展名判定', () => {
    expect(isAllowedMomarkFileExtension('/tmp/a.png?mucache=3')).toBe(true)
  })

  it('scheme 常量与 CSP 里写的一致', () => {
    expect(MOMARK_FILE_SCHEME).toBe('momark-file')
  })
})
