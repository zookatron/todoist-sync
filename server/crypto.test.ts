import { describe, expect, it } from 'vitest'
import { decrypt, encrypt } from './crypto.js'

describe('encrypt/decrypt', () => {
  it('round-trips a value', () => {
    const secret = 'todoist-access-token-abc123'

    expect(decrypt(encrypt(secret))).toBe(secret)
  })

  it('round-trips unicode and empty strings', () => {
    for (const value of ['', 'a', '🔐 ünïcode ✓', 'x'.repeat(5000)]) {
      expect(decrypt(encrypt(value))).toBe(value)
    }
  })

  it('produces different ciphertext for the same plaintext', () => {
    // A random IV per call: identical secrets must not be correlatable in the database.
    expect(encrypt('same')).not.toBe(encrypt('same'))
  })

  it('does not leak the plaintext into the stored value', () => {
    expect(encrypt('super-secret-token')).not.toContain('super-secret-token')
  })

  it('rejects tampered ciphertext', () => {
    const [iv, authTag, ciphertext] = encrypt('original').split('.') as [string, string, string]
    const flipped = Buffer.from(ciphertext, 'base64')
    flipped[0] = (flipped[0] ?? 0) ^ 0xff

    expect(() => decrypt([iv, authTag, flipped.toString('base64')].join('.'))).toThrow()
  })

  it('rejects a malformed value', () => {
    expect(() => decrypt('not-encrypted')).toThrow(/iv\.authTag\.ciphertext/)
    expect(() => decrypt('a.b.c')).toThrow(/malformed/)
  })
})
