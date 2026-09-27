import { describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/momark-test-userdata' },
  session: { fromPartition: () => ({ cookies: { get: async () => [], set: async () => {} } }) }
}))
// Avoid pulling the whole panel module (and its electron usage) in.
vi.mock('main_renderer/browserPanel', () => ({ BP_PARTITION: 'persist:panel' }))

const { deriveChromeCookieKey, decryptChromeCookieValue } =
  await import('main_renderer/chromeCookieSync')

// Chromium macOS: key = PBKDF2-SHA1(password, 'saltysalt', 1003, 16).
// Known-answer vector for Chromium's own test password "peanuts", computed
// independently with Python's `hashlib.pbkdf2_hmac` — if the parameters (salt,
// iteration count, hash, length) ever drift, this fails.
const PEANUTS_KEY = 'd9a09d499b4e1b7461f28e67972c6dbd'

const encryptV10 = (key: Buffer, hostKey: string, value: string, version = 'v10'): Buffer => {
  const prefix =
    version === 'v10'
      ? crypto.createHash('sha256').update(hostKey, 'utf8').digest()
      : Buffer.alloc(0)
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([
    Buffer.from(version, 'latin1'),
    cipher.update(Buffer.concat([prefix, Buffer.from(value, 'utf8')])),
    cipher.final()
  ])
}

describe('deriveChromeCookieKey — macOS PBKDF2 parameters', () => {
  it('matches the independently computed Chromium vector', () => {
    const key = deriveChromeCookieKey('peanuts')
    expect(key.length).toBe(16)
    expect(key.toString('hex')).toBe(PEANUTS_KEY)
  })

  it('gives a different key for a different keychain password', () => {
    expect(deriveChromeCookieKey('peanuts2').toString('hex')).not.toBe(PEANUTS_KEY)
  })
})

describe('decryptChromeCookieValue — v10/v11 layout', () => {
  const key = deriveChromeCookieKey('peanuts')

  it('decrypts a v10 cookie (32-byte SHA256(host_key) prefix stripped)', () => {
    const encrypted = encryptV10(key, '.example.com', 'SESSION=abc123')
    expect(decryptChromeCookieValue(key, '.example.com', encrypted)).toBe('SESSION=abc123')
  })

  it('decrypts a v11 cookie (no prefix)', () => {
    const encrypted = encryptV10(key, '.example.com', 'SESSION=abc123', 'v11')
    expect(decryptChromeCookieValue(key, '.example.com', encrypted)).toBe('SESSION=abc123')
  })

  it('rejects a cookie whose 32-byte prefix belongs to another host', () => {
    const encrypted = encryptV10(key, '.example.com', 'SESSION=abc123')
    expect(decryptChromeCookieValue(key, '.evil.com', encrypted)).toBeNull()
  })

  it('rejects values decrypted with the wrong key instead of writing garbage', () => {
    // Before the prefix check, ~1/256 of these passed PKCS7 validation and were
    // written into the panel partition as binary junk.
    const wrongKey = crypto.randomBytes(16)
    for (let i = 0; i < 64; i++) {
      const encrypted = encryptV10(wrongKey, '.example.com', `SESSION=${i}`)
      expect(decryptChromeCookieValue(key, '.example.com', encrypted)).toBeNull()
    }
  })

  it('rejects unsupported versions (App-Bound Encryption) and short buffers', () => {
    expect(decryptChromeCookieValue(key, 'h', encryptV10(key, 'h', 'v', 'v20'))).toBeNull()
    expect(decryptChromeCookieValue(key, 'h', Buffer.from('v10'))).toBeNull()
    expect(decryptChromeCookieValue(key, 'h', new Uint8Array(0))).toBeNull()
  })
})
