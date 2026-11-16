import fsPromises from 'fs/promises'
import path from 'path'
import iconv from 'iconv-lite'
import log from 'electron-log'
import type { BrowserWindow } from 'electron'
import { guessEncoding } from './encoding'
import { t } from '../i18n'
import type { HtmlFileDocument } from '@shared/types/files'
import { HTML_FILE_MAX_BYTES } from 'common/html/limits'
import { toStandaloneHtml } from 'common/html/standalone'
import { writeFile } from './index'

export class HtmlFileTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`HTML file is too large (${size} bytes).`)
  }
}

/**
 * 读一个本地 HTML 文件，交给渲染层作为只读 html 标签在沙箱帧里显示。
 * 编码沿用 Markdown 的探测（BOM / 自动猜测），GBK 原型也不会乱码。
 */
export const readHtmlFile = async (pathname: string): Promise<HtmlFileDocument> => {
  const resolved = path.resolve(pathname)
  const stat = await fsPromises.stat(resolved)
  if (stat.size > HTML_FILE_MAX_BYTES) {
    throw new HtmlFileTooLargeError(stat.size)
  }

  const buffer = await fsPromises.readFile(resolved)
  const encoding = guessEncoding(buffer, true)
  const html = iconv.encodingExists(encoding.encoding)
    ? iconv.decode(buffer, encoding.encoding)
    : buffer.toString('utf8')

  return {
    pathname: resolved,
    filename: path.basename(resolved),
    html
  }
}

/**
 * 把 HTML 块写成独立 .html，返回交给渲染层作为 html 标签打开的文档。不回读：写入的内容就是要显示的
 * 内容，回读会再过一遍打开上限，超过 32MB 的块会「写成功却报保存失败」。
 */
export const saveHtmlFile = async (
  target: string,
  blockHtml: string
): Promise<HtmlFileDocument> => {
  const resolved = path.resolve(target)
  const html = toStandaloneHtml(blockHtml)
  await writeFile(resolved, html, undefined, 'utf-8')
  return {
    pathname: resolved,
    filename: path.basename(resolved),
    html
  }
}

/** 读失败（不存在 / 权限 / 超上限）时给窗口发一条通知，返回 null。 */
export const readHtmlFileOrNotify = async (
  win: BrowserWindow | null,
  pathname: string
): Promise<HtmlFileDocument | null> => {
  try {
    return await readHtmlFile(pathname)
  } catch (error) {
    log.error('[html-file] read failed:', pathname, error)
    const message =
      error instanceof HtmlFileTooLargeError
        ? t('editor.htmlFile.tooLarge', { size: `${(error.size / 1024 / 1024).toFixed(1)} MB` })
        : error instanceof Error
          ? error.message
          : String(error)
    if (win && !win.isDestroyed()) {
      win.webContents.send('mt::show-notification', {
        title: t('editor.htmlFile.cannotOpen'),
        type: 'error',
        message
      })
    }
    return null
  }
}
