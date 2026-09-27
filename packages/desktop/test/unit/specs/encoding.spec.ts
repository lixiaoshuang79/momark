import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import iconv from 'iconv-lite'

// `ced` (compact_enc_det) occasionally misdetects a valid UTF-8 file as a legacy
// double-byte encoding, mojibaking multi-byte text — e.g. Greek µ/κ/α become CJK
// 碌/魏/伪 (#3151). Simulate that by forcing `ced` to always answer GBK; the fix
// must override it whenever the bytes are valid UTF-8.
vi.mock('ced', () => ({ default: vi.fn(() => 'GB') }))

const cedModule = await import('ced')
const cedMock = vi.mocked(cedModule.default)

const { guessEncoding, encodeLosslessly } = await import('main_renderer/filesystem/encoding')

// A buffer that is NOT valid UTF-8 (0xC2 is a UTF-8 lead byte, the following
// space is not a continuation byte), so `ced` is actually consulted.
const NOT_UTF8 = Buffer.from([0x68, 0x69, 0xc2, 0x20, 0x6f, 0x6b])

describe('guessEncoding — prefer UTF-8 over a ced misdetection (#3151)', () => {
  it('returns utf8 for a valid UTF-8 buffer even when ced guesses GBK', () => {
    const buffer = Buffer.from('# Notes\n\nµ = 0.5, κ, α — Greek letters.\n', 'utf8')
    expect(guessEncoding(buffer, true).encoding).toBe('utf8')
  })

  it('still falls back to ced for a genuinely non-UTF-8 buffer', () => {
    expect(guessEncoding(NOT_UTF8, true).encoding).toBe('gb18030')
  })

  it('does not force utf8 for a buffer containing NUL (binary / BOM-less UTF-16)', () => {
    const buffer = Buffer.from([0x68, 0x00, 0x65, 0x00, 0x6c, 0x00])
    expect(guessEncoding(buffer, true).encoding).not.toBe('utf8')
  })

  it('honours a UTF-8 BOM and never reaches ced', () => {
    const buffer = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])
    const result = guessEncoding(buffer, true)
    expect(result.encoding).toBe('utf8')
    expect(result.isBom).toBe(true)
  })
})

describe('guessEncoding — ced names map to decodable iconv codecs', () => {
  const mapping: Array<[string, string]> = [
    // ced's "GB" is GBK/CP936 in practice; gb2312 cannot hold GBK-only text.
    ['GB', 'gb18030'],
    ['SJS', 'shiftjis'],
    ['shiftjis', 'shiftjis'],
    ['MACINTOSH', 'macintosh'],
    // ced's "Unicode" is UTF-16 (MIME name UTF-16LE), never UTF-8.
    ['Unicode', 'utf16le'],
    ['KSC', 'euckr'],
    ['BIG5-CP950', 'big5'],
    // fallback normalization: lower-case + strip `-`/`_` (the old `/-_/`
    // regex matched the literal "-_" pair and only lower-cased).
    ['GBK', 'gbk'],
    ['EUC-JP', 'eucjp'],
    ['ISO-8859-5', 'iso88595'],
    ['BIG5_HKSCS', 'big5hkscs'],
    ['CP932', 'cp932']
  ]

  for (const [cedName, codec] of mapping) {
    it(`maps ced "${cedName}" to "${codec}"`, () => {
      cedMock.mockReturnValueOnce(cedName)
      const result = guessEncoding(NOT_UTF8, true)
      expect(result.encoding).toBe(codec)
      expect(iconv.encodingExists(codec)).toBe(true)
    })
  }

  it('names ISO-2022-JP correctly so unsupported files are refused, not mojibaked', () => {
    // iconv-lite cannot decode ISO-2022-JP; `loadMarkdownFile` rejects unknown
    // codecs, which is the intended safe outcome (no U+FFFD written back).
    cedMock.mockReturnValueOnce('JIS')
    const result = guessEncoding(NOT_UTF8, true)
    expect(result.encoding).toBe('iso-2022-jp')
    expect(iconv.encodingExists(result.encoding)).toBe(false)
  })
})

describe('encodeLosslessly — refuse lossy saves instead of writing "?"', () => {
  it('accepts gb18030 content that includes an emoji (GBK files keep their text)', () => {
    const content = '你好 ok 😀 🔥'
    const buffer = encodeLosslessly(content, { encoding: 'gb18030' })
    expect(buffer).not.toBeNull()
    expect(iconv.decode(buffer!, 'gb18030')).toBe(content)
  })

  it('rejects gb2312 content with an emoji (the character would become "?")', () => {
    expect(encodeLosslessly('你好 ok 😀', { encoding: 'gb2312' })).toBeNull()
  })

  it('rejects content outside the target codec (Korean text as Shift JIS)', () => {
    expect(encodeLosslessly('한국어', { encoding: 'shiftjis' })).toBeNull()
    expect(encodeLosslessly('日本語テキスト', { encoding: 'shiftjis' })).not.toBeNull()
  })

  it('keeps multi-byte text intact for the legacy codecs we map to', () => {
    expect(encodeLosslessly('繁體中文', { encoding: 'big5' })).not.toBeNull()
    expect(encodeLosslessly('한국어', { encoding: 'euckr' })).not.toBeNull()
    expect(encodeLosslessly('café', { encoding: 'macintosh' })).not.toBeNull()
    expect(encodeLosslessly('日本語', { encoding: 'euc-jp' })).not.toBeNull()
  })

  it('preserves the BOM flag when writing UTF-16', () => {
    const buffer = encodeLosslessly('你好', { encoding: 'utf16be', isBom: true })
    expect(buffer).not.toBeNull()
    expect(buffer!.subarray(0, 2).toString('hex')).toBe('feff')
  })

  it('leaves UTF-8 saves alone (nothing to round-trip)', () => {
    const buffer = encodeLosslessly('你好 😀', { encoding: 'utf8' })
    expect(buffer).not.toBeNull()
    expect(buffer!.toString('utf8')).toBe('你好 😀')
  })
})

describe('writeMarkdownFile — the guard is wired into the write path', () => {
  const docPath = (name: string) =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momark-encoding-')), name)

  it('refuses to save a GBK document once it contains an emoji, leaving the file untouched', async () => {
    const { writeMarkdownFile } = await import('main_renderer/filesystem/markdown')
    const file = docPath('gb.md')
    fs.writeFileSync(file, iconv.encode('# 中文标题\n', 'gb2312'))

    await expect(
      writeMarkdownFile(file, '# 中文标题 😀\n', {
        adjustLineEndingOnSave: false,
        lineEnding: 'lf',
        encoding: { encoding: 'gb2312' }
      })
    ).rejects.toThrow(/Cannot save/)

    expect(iconv.decode(fs.readFileSync(file), 'gb2312')).toBe('# 中文标题\n')
  })

  it('saves the same document once it is UTF-8 (the suggested way out)', async () => {
    const { writeMarkdownFile } = await import('main_renderer/filesystem/markdown')
    const file = docPath('utf8.md')

    await writeMarkdownFile(file, '# 中文标题 😀\n', {
      adjustLineEndingOnSave: false,
      lineEnding: 'lf',
      encoding: { encoding: 'utf8' }
    })

    expect(fs.readFileSync(file, 'utf8')).toBe('# 中文标题 😀\n')
  })

  it('saves GB18030 content that still fits the legacy encoding', async () => {
    const { writeMarkdownFile } = await import('main_renderer/filesystem/markdown')
    const file = docPath('gb18030.md')

    await writeMarkdownFile(file, '# 中文标题\n', {
      adjustLineEndingOnSave: false,
      lineEnding: 'lf',
      encoding: { encoding: 'gb18030' }
    })

    expect(iconv.decode(fs.readFileSync(file), 'gb18030')).toBe('# 中文标题\n')
  })
})
