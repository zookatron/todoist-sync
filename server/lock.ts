import { randomUUID } from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'
import { type Database, db as defaultDb } from './db/index.js'
import { locks } from './db/schema/locks.js'

export class LockUnavailableError extends Error {
  readonly key: string

  constructor(key: string) {
    super(`Lock "${key}" is held by another job`)
    this.name = 'LockUnavailableError'
    this.key = key
  }
}

export type Lock = {
  key: string
  owner: string
  expiresAt: Date
}

export type AcquireOptions = {
  /** Identifies the holder. Defaults to a random id; pass the job id where there is one. */
  owner?: string
  /**
   * How long the lock is held before another caller may steal it. Set this comfortably
   * above the expected work duration — an under-set TTL lets a second worker in while
   * the first is still running.
   */
  ttlMs: number
  db?: Database
}

/**
 * Attempts to take a lock. Returns null if another (unexpired) owner holds it.
 *
 * The acquire is a single statement, which is what makes it atomic without a
 * transaction: `ON CONFLICT DO UPDATE` re-takes the row only when the existing lock has
 * expired, and the `RETURNING` clause yields no row when the `WHERE` filters the update
 * out. So "did I get it?" is exactly "did a row come back?".
 */
export async function acquireLock(key: string, options: AcquireOptions): Promise<Lock | null> {
  const { ttlMs, owner = randomUUID(), db = defaultDb } = options
  const expiry = sql`now() + ${`${ttlMs} milliseconds`}::interval`

  const rows = await db
    .insert(locks)
    .values({ key, owner, expiresAt: expiry })
    .onConflictDoUpdate({
      target: locks.key,
      set: { owner, acquiredAt: sql`now()`, expiresAt: expiry },
      where: lt(locks.expiresAt, sql`now()`),
    })
    .returning()

  const row = rows[0]
  return row ? { key: row.key, owner: row.owner, expiresAt: row.expiresAt } : null
}

/**
 * Releases a lock, but only if `owner` still holds it.
 *
 * The owner check matters: if this lock already expired and was stolen, releasing it
 * would hand the new holder's lock away while they are still working.
 *
 * @returns whether a lock was actually released.
 */
export async function releaseLock(
  key: string,
  owner: string,
  db: Database = defaultDb,
): Promise<boolean> {
  const rows = await db
    .delete(locks)
    .where(and(eq(locks.key, key), eq(locks.owner, owner)))
    .returning()

  return rows.length > 0
}

/**
 * Runs `fn` while holding `key`, releasing it afterwards even if `fn` throws.
 *
 * Throws {@link LockUnavailableError} when the lock is already held. Callers decide what
 * contention means: the per-task sync job lets it propagate (the job fails and BullMQ
 * retries), whereas the poll job catches it and exits cleanly.
 */
export async function withLock<T>(
  key: string,
  options: AcquireOptions,
  fn: (lock: Lock) => Promise<T>,
): Promise<T> {
  const lock = await acquireLock(key, options)

  if (!lock) {
    throw new LockUnavailableError(key)
  }

  try {
    return await fn(lock)
  } finally {
    await releaseLock(key, lock.owner, options.db)
  }
}

/**
 * Deletes locks that expired more than `olderThanMs` ago.
 *
 * Expired locks are already stealable, so this is pure housekeeping to stop the table
 * growing without bound. Run periodically from the worker.
 */
export async function cleanupExpiredLocks(
  olderThanMs = 60 * 60 * 1000,
  db: Database = defaultDb,
): Promise<number> {
  const rows = await db
    .delete(locks)
    .where(lt(locks.expiresAt, sql`now() - ${`${olderThanMs} milliseconds`}::interval`))
    .returning()

  return rows.length
}
