import ced from 'ced'
import iconv from 'iconv-lite'
import type { Encoding } from 'common/encoding'

// `ced` (compact_enc_det) reports its own encoding names — the first column of
// `kEncodingInfoTable` in node_modules/ced/vendor/compact_enc_det/util/encodings/
// encodings.cc. Every mapping here must be a codec name that iconv-lite can
// DECODE and ENCODE, otherwise the file is silently mojibaked on open and
// permanently corrupted on save (a legacy file only reaches this table when it
// already failed the UTF-8 check in `isLikelyUtf8`).
//
// A name iconv-lite does not know is not silently ignored: it falls through to
// the normalization below and then to the "encoding is not supported" gate in
// `loadMarkdownFile`, i.e. the file is refused instead of corrupted.
const CED_ICONV_ENCODINGS: Record<string, string> = {
  'BIG5-CP950': 'big5',
  KSC: 'euckr',
  'ISO-2022-KR': 'euckr',
  // `ced`'s "GB" is GBK/CP936 in practice (compact_enc_det's own preferred
  // output for it is GBK): gb2312 drops GBK-only and GB18030-only characters
  // (and every emoji) to "?" on save, gb18030 is a superset of both.
  GB: 'gb18030',
  ISO_2022_CN: 'gb18030',

  // ced's "Unicode" is UTF-16 (its MIME name is UTF-16LE); decoding such a file
  // as UTF-8 leaves NUL bytes in every other position.
  Unicode: 'utf16le',

  // Map ASCII / subsets of UTF-8 to UTF-8 (lossless both ways).
  'ASCII-7-bit': 'utf8',
  ASCII: 'utf8',

  // Japanese/Korean legacy codecs — these must never be decoded as UTF-8:
  // every multi-byte sequence would become U+FFFD and be written back as such.
  SJS: 'shiftjis',
  shiftjis: 'shiftjis',
  // ISO-2022-JP is not supported by iconv-lite; naming it correctly here means
  // such a file is refused by the supported-encoding gate rather than mojibaked.
  JIS: 'iso-2022-jp',
  MACINTOSH: 'macintosh'
}

// Codecs that can represent every well-formed string, so a round-trip check
// cannot catch anything but ill-formed data (lone surrogates). Blocking a save
// over those would be worse than the replacement character iconv writes, so the
// check is skipped for them (see `encodeLosslessly`).
const UNICODE_CODECS = new Set(['utf8', 'utf16le', 'utf16be', 'utf32le', 'utf32be'])

// Byte Order Marks to detect endianness and encoding.
const BOM_ENCODINGS: Record<string, number[]> = {
  utf8: [0xef, 0xbb, 0xbf],
  utf16be: [0xfe, 0xff],
  utf16le: [0xff, 0xfe]
}

const checkSequence = (buffer: Buffer, sequence: number[]): boolean => {
  if (buffer.length < sequence.length) {
    return false
  }
  return sequence.every((v, i) => v === buffer[i])
}

// `ced` occasionally misdetects a valid UTF-8 file as a legacy double-byte
// encoding (notably GBK), mojibaking multi-byte text — e.g. Greek µ/κ/α become
// CJK 碌/魏/伪 (#3151). A NUL byte signals binary / BOM-less UTF-16, not a UTF-8
// text file.
const isLikelyUtf8 = (buffer: Buffer): boolean => {
  if (buffer.includes(0)) {
    return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

/**
 * Guess the encoding from the buffer.
 */
export const guessEncoding = (buffer: Buffer, autoGuessEncoding: boolean): Encoding => {
  const isBom = false
  let encoding = 'utf8'

  // Detect UTF8- and UTF16-BOM encodings.
  for (const [key, value] of Object.entries(BOM_ENCODINGS)) {
    if (checkSequence(buffer, value)) {
      return { encoding: key, isBom: true }
    }
  }

  // Auto guess encoding, otherwise use UTF-8.
  if (autoGuessEncoding) {
    // A file that is already valid UTF-8 must be decoded as UTF-8, regardless
    // of what `ced` heuristically guesses (#3151).
    if (isLikelyUtf8(buffer)) {
      return { encoding: 'utf8', isBom }
    }
    encoding = ced(buffer)
    if (CED_ICONV_ENCODINGS[encoding]) {
      encoding = CED_ICONV_ENCODINGS[encoding]
    } else {
      // `[-_]` (the previous `/-_/` matched the literal two-character sequence
      // "-_" and therefore normalized nothing but the case).
      encoding = encoding.toLowerCase().replace(/[-_]/g, '')
    }
  }
  return { encoding, isBom }
}

/**
 * Encode `content` for writing, refusing encodings that cannot represent it.
 *
 * iconv-lite substitutes a character it cannot map with "?" without any error,
 * so a GBK document with an emoji (or any character outside the codec) would be
 * written back with those characters replaced — a silent, permanent loss of the
 * original bytes. Re-encoding and decoding the result catches exactly that.
 *
 * @returns the encoded buffer, or `null` when the round-trip is lossy.
 */
export const encodeLosslessly = (content: string, encoding: Encoding): Buffer | null => {
  const codec = encoding.encoding
  const buffer = iconv.encode(content, codec, { addBOM: !!encoding.isBom })
  if (UNICODE_CODECS.has(codec)) {
    return buffer
  }
  try {
    return iconv.decode(buffer, codec) === content ? buffer : null
  } catch {
    return null
  }
}
