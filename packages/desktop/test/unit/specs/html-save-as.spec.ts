import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 「另存为 .html」写完直接把写入内容交给右栏，不回读：回读会再过一遍 32MB 打开上限，
// 大块会「文件已写好却报保存失败、右栏也不打开」。
// 「粘贴 html → 内嵌到文档」读入口文件走 `mt::html::read`（32MB 上限 + 编码探测），
// 不再直接 `fileUtils.readFile` 整份读。

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { HTML_FILE_MAX_BYTES } from 'common/html/limits'
import {
  HtmlFileTooLargeError,
  readHtmlFile,
  saveHtmlFile
} from '../../../src/main/filesystem/htmlFile'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momark-save-as-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('saveHtmlFile', () => {
  it('returns the written document even when it is over the open limit', async () => {
    const target = path.join(dir, 'big.html')
    const body = `<p>${'x'.repeat(HTML_FILE_MAX_BYTES + 1024)}</p>`
    const doc = await saveHtmlFile(target, `<!--momark-frame w=1 h=2 z=1-->\n${body}`)

    expect(doc.pathname).toBe(target)
    expect(doc.filename).toBe('big.html')
    expect(doc.html).toBe(`<!DOCTYPE html>\n${body}`)
    expect(fs.statSync(target).size).toBe(Buffer.byteLength(doc.html))
    // 打开路径的上限不变：同一个文件经「打开」仍按 32MB 拒绝。
    await expect(readHtmlFile(target)).rejects.toBeInstanceOf(HtmlFileTooLargeError)
  })
})

describe('paste → embed reads the entry through mt::html::read', () => {
  it('editor.vue embedHtmlFile no longer reads the file directly', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/renderer/src/components/editorWithTabs/editor.vue'),
      'utf8'
    )
    const body = src.slice(src.indexOf('const embedHtmlFile'), src.indexOf('const uploadHtmlFile'))
    expect(body).toContain("invoke('mt::html::read', path)")
    expect(body).not.toContain('fileUtils.readFile')
  })
})
