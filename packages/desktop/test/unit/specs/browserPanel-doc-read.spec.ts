import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import iconv from 'iconv-lite'

// P0-6: `bp:readDoc` (right-panel recents / open file) used to
// `fs.readFile(path, 'utf-8')` directly, bypassing encoding detection — a GBK
// document showed up as mojibake and the panel's first save overwrote the file
// with that mojibake. It must now go through `loadMarkdownFile` like every
// other open path.
vi.mock('ced', () => ({ default: vi.fn(() => 'GB') }))

const state = vi.hoisted(() => ({ dir: '', handle: vi.fn(), on: vi.fn() }))

vi.mock('electron', async () => {
  const nodeOs = await import('os')
  const nodeFs = await import('fs')
  const nodePath = await import('path')
  state.dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'momark-panel-doc-'))
  return {
    app: { getPath: () => state.dir },
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: { handle: state.handle, on: state.on },
    session: {
      fromPartition: () => ({
        cookies: { get: async () => [], set: async () => {} },
        on: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn()
      })
    },
    shell: { openExternal: vi.fn() },
    BrowserWindow: { fromWebContents: () => null }
  }
})

const { registerBrowserPanelIpc } = await import('main_renderer/browserPanel')

interface PanelDoc {
  path: string
  pathname: string
  filename: string
  markdown: string
  encoding: { encoding: string; isBom?: boolean }
  lineEnding: 'lf' | 'crlf'
  adjustLineEndingOnSave: boolean
  trimTrailingNewline: number
  isMixedLineEndings: boolean
}

const readDocHandler = (): ((e: unknown, p: string) => Promise<PanelDoc | null>) => {
  registerBrowserPanelIpc()
  const call = state.handle.mock.calls.find(([channel]) => channel === 'bp:readDoc')
  expect(call).toBeTruthy()
  return call![1] as (e: unknown, p: string) => Promise<PanelDoc | null>
}

let docDir = ''
const writeDoc = (name: string, buffer: Buffer): string => {
  const file = path.join(docDir, name)
  fs.writeFileSync(file, buffer)
  return file
}

const writePreferences = (prefs: Record<string, unknown>) => {
  fs.writeFileSync(path.join(state.dir, 'preferences.json'), JSON.stringify(prefs))
}

docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momark-panel-docs-'))

describe('bp:readDoc — standard open flow (P0-6)', () => {
  it('decodes a GBK document and reports its real encoding', async () => {
    writePreferences({ autoGuessEncoding: true, trimTrailingNewline: 2, endOfLine: 'lf' })
    const file = writeDoc('gbk.md', iconv.encode('# 中文标题\n', 'gbk'))

    const doc = await readDocHandler()({ sender: { id: 1 } }, file)

    expect(doc).not.toBeNull()
    expect(doc!.markdown).toBe('# 中文标题\n')
    expect(doc!.encoding.encoding).toBe('gb18030')
    expect(doc!.pathname).toBe(path.resolve(file))
    expect(doc!.filename).toBe('gbk.md')
    expect(doc!.path).toBe(path.resolve(file))
  })

  it('detects CRLF endings and asks for them back on save', async () => {
    writePreferences({ autoGuessEncoding: true, trimTrailingNewline: 2, endOfLine: 'lf' })
    const file = writeDoc('crlf.md', Buffer.from('# Title\r\n\r\nbody\r\n', 'utf8'))

    const doc = await readDocHandler()({ sender: { id: 1 } }, file)

    expect(doc!.lineEnding).toBe('crlf')
    expect(doc!.adjustLineEndingOnSave).toBe(true)
    // Markdown is normalized to LF internally.
    expect(doc!.markdown).not.toContain('\r')
  })

  it('reports a UTF-8 BOM and strips it from the markdown', async () => {
    writePreferences({ autoGuessEncoding: true, trimTrailingNewline: 2, endOfLine: 'lf' })
    const file = writeDoc(
      'bom.md',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# hi\n')])
    )

    const doc = await readDocHandler()({ sender: { id: 1 } }, file)

    expect(doc!.encoding).toEqual({ encoding: 'utf8', isBom: true })
    expect(doc!.markdown.startsWith('# hi')).toBe(true)
  })

  it('honours the autoGuessEncoding preference (utf8 forced when disabled)', async () => {
    writePreferences({ autoGuessEncoding: false, trimTrailingNewline: 2, endOfLine: 'lf' })
    const file = writeDoc('gbk-noguess.md', iconv.encode('# 中文标题\n', 'gbk'))

    const doc = await readDocHandler()({ sender: { id: 1 } }, file)

    expect(doc!.encoding.encoding).toBe('utf8')
    expect(doc!.markdown).toContain('�')
  })

  it('returns null (no throw) when the document cannot be read', async () => {
    const doc = await readDocHandler()({ sender: { id: 1 } }, path.join(docDir, 'missing.md'))
    expect(doc).toBeNull()
  })
})
