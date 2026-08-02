import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { customType } from 'drizzle-orm/pg-core'
import { env } from './env.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM standard
const AUTH_TAG_LENGTH = 16

function key(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, 'base64')
}

/**
 * Encrypts a value with AES-256-GCM.
 *
 * Output format is `iv.authTag.ciphertext`, each part base64. The IV is random per
 * call, so encrypting the same plaintext twice produces different ciphertext.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    '.',
  )
}

/**
 * Reverses {@link encrypt}. Throws if the value was tampered with, or if
 * ENCRYPTION_KEY has changed since the value was written.
 */
export function decrypt(encoded: string): string {
  const parts = encoded.split('.')
  if (parts.length !== 3) {
    throw new Error('Cannot decrypt value: expected "iv.authTag.ciphertext" format')
  }

  const [ivPart, authTagPart, ciphertextPart] = parts as [string, string, string]
  const iv = Buffer.from(ivPart, 'base64')
  const authTag = Buffer.from(authTagPart, 'base64')

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Cannot decrypt value: malformed IV or authentication tag')
  }

  const decipher = createDecipheriv(ALGORITHM, key(), iv)
  decipher.setAuthTag(authTag)

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * A text column that is transparently encrypted at rest.
 *
 * Call sites read and write plaintext; only ciphertext reaches Postgres. Use this for
 * every stored third-party credential.
 *
 * Note that encrypted columns cannot be searched or indexed by value — the ciphertext
 * differs on every write.
 */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text'
  },
  toDriver(value: string): string {
    return encrypt(value)
  },
  fromDriver(value: string): string {
    return decrypt(value)
  },
})
