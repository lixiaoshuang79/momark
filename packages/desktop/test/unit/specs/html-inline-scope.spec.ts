import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 本地 .html 资源内联的读取范围与体积上限：内联结果会投进能跑脚本的沙箱帧，
// html 所在目录之外的文件（含经符号链接逃出去的）不能读进来，超大的资源不能整份读。
// 用真实临时目录跑，realpath / 符号链接行为与线上一致。

vi.mock('common/html/limits', () => ({
  HTML_FILE_MAX_BYTES: 1000,
  HTML_INLINE_RESOURCE_MAX_BYTES: 100,
  HTML_INLINE_TOTAL_MAX_BYTES: 1000
}))

import { isChildOfDirectory, isHtmlFile } from 'common/filesystem/paths'
import {
  describeMissedResources,
  inlineHtmlDocument,
  inlineHtmlForPreview
} from '@/util/htmlInline'

let root: string
let proj: string
const readFile = vi.fn(async (p: string, enc?: string) =>
  fs.promises.readFile(p, enc as BufferEncoding)
)

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'momark-inline-')))
  proj = path.join(root, 'proj')
  fs.mkdirSync(path.join(proj, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP-SECRET')
  fs.writeFileSync(path.join(proj, 'app.css'), 'body{color:red}')
  fs.writeFileSync(path.join(proj, 'sub', 'app.js'), 'window.ok=1')
  fs.writeFileSync(path.join(proj, 'sub', 'a.png'), 'PNG')
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(proj, 'escape.js'))
  fs.symlinkSync(path.join(proj, 'app.css'), path.join(proj, 'alias.css'))
  fs.writeFileSync(path.join(proj, 'big.js'), 'x'.repeat(101))
  for (const n of ['p1', 'p2', 'p3', 'p4']) {
    fs.writeFileSync(path.join(proj, `${n}.js`), n.repeat(45))
  }
  fs.writeFileSync(path.join(proj, 'pic.png'), 'y'.repeat(90))

  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.fileUtils = {
    realpath: (p: string) => fs.promises.realpath(p),
    stat: async (p: string) => {
      const s = await fs.promises.stat(p)
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() }
    },
    readFile,
    isChildOfDirectory
  }
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  readFile.mockClear()
})

const entry = () => path.join(proj, 'index.html')

describe('inline scope — only the html file’s own folder', () => {
  it('inlines same-folder and sub-folder resources, and links that stay inside', async () => {
    const raw =
      '<link rel="stylesheet" href="alias.css"><script src="sub/app.js"></script><img src="sub/a.png">'
    const out = await inlineHtmlForPreview(raw, entry())
    expect(out.html).toContain('<style>body{color:red}</style>')
    expect(out.html).toContain('<script>window.ok=1</script>')
    expect(out.html).toContain('src="data:image/png;base64,')
    expect(out.missed).toEqual([])
  })

  it.each([
    ['relative ../', '../secret.txt'],
    ['absolute path', '__ROOT__/secret.txt'],
    ['percent-encoded ..%2f', '..%2fsecret.txt'],
    ['sub/../../ climb', 'sub/../../secret.txt'],
    ['symlink pointing outside', 'escape.js']
  ])('refuses %s without reading it', async (_label, ref) => {
    const src = ref.replace('__ROOT__', root)
    const out = await inlineHtmlForPreview(`<script src="${src}"></script>`, entry())
    expect(out.html).not.toContain('TOP-SECRET')
    expect(out.missed).toHaveLength(1)
    expect(out.missed[0].reason).toBe('outside')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('applies the same scope to the paste → embed-into-document path', async () => {
    const out = await inlineHtmlDocument('<img src="../secret.txt">', entry())
    expect(out.missed).toEqual([{ path: path.join(root, 'secret.txt'), reason: 'outside' }])
    expect(out.html).toContain('src="../secret.txt"')
  })

  it('checks CSS url() references against the html folder, not the stylesheet folder', async () => {
    fs.writeFileSync(path.join(proj, 'sub', 'deep.css'), '.a{background:url(../../secret.txt)}')
    const out = await inlineHtmlForPreview('<link rel="stylesheet" href="sub/deep.css">', entry())
    expect(out.html).not.toContain('VE9QLVNFQ1JFVA')
    expect(out.missed).toEqual([{ path: path.join(root, 'secret.txt'), reason: 'outside' }])
  })

  it('tells missing files apart from out-of-scope ones', async () => {
    const out = await inlineHtmlForPreview(
      '<script src="gone.js"></script><script src="../secret.txt"></script>',
      entry()
    )
    expect(out.missed.map((m) => m.reason).sort()).toEqual(['missing', 'outside'])
    expect(describeMissedResources(out.missed)).toBe(
      "1 outside the HTML file's folder, 1 not found"
    )
  })
})

describe('inline size limits', () => {
  it('skips a resource over the per-file limit without reading it', async () => {
    const out = await inlineHtmlForPreview('<script src="big.js"></script>', entry())
    expect(out.missed).toEqual([{ path: path.join(proj, 'big.js'), reason: 'too-large' }])
    expect(readFile).not.toHaveBeenCalled()
  })

  it('stops inlining once the whole document would exceed the total budget', async () => {
    // 总量 1000 − 入口 600 = 400：四个 90 字节脚本放得下（360），90 字节图片按 base64 计
    // 120，放不下。
    const tags =
      '<script src="p1.js"></script><script src="p2.js"></script>' +
      '<script src="p3.js"></script><script src="p4.js"></script><img src="pic.png">'
    const out = await inlineHtmlForPreview(tags.padEnd(600, ' '), entry())
    expect(out.inlined).toHaveLength(4)
    expect(out.missed).toEqual([{ path: path.join(proj, 'pic.png'), reason: 'too-large' }])
    expect(readFile).toHaveBeenCalledTimes(4)
  })
})

describe('isHtmlFile follows symlinks', () => {
  it('accepts a .html link to a .html file and rejects one pointing at a script', () => {
    const target = path.join(proj, 'real.html')
    fs.writeFileSync(target, '<p>x</p>')
    const deploy = path.join(proj, 'deploy')
    fs.writeFileSync(deploy, '#!/bin/sh\necho hi\n', { mode: 0o755 })
    fs.symlinkSync(target, path.join(proj, 'good.html'))
    fs.symlinkSync(deploy, path.join(proj, 'notes.html'))
    fs.symlinkSync(path.join(proj, 'good.html'), path.join(proj, 'chain.html'))

    expect(isHtmlFile(target)).toBe(true)
    expect(isHtmlFile(path.join(proj, 'good.html'))).toBe(true)
    expect(isHtmlFile(path.join(proj, 'chain.html'))).toBe(true)
    expect(isHtmlFile(path.join(proj, 'notes.html'))).toBe(false)
    expect(isHtmlFile(path.join(proj, 'missing.html'))).toBe(false)
  })
})
