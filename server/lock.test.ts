import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, pool } from './db/index.js'
import { locks } from './db/schema/locks.js'
import {
  acquireLock,
  cleanupExpiredLocks,
  LockUnavailableError,
  releaseLock,
  withLock,
} from './lock.js'

beforeEach(async () => {
  await db.delete(locks)
})

afterAll(async () => {
  await db.delete(locks)
  await pool.end()
})

describe('acquireLock', () => {
  it('grants the lock when it is free', async () => {
    const lock = await acquireLock('test:free', { owner: 'a', ttlMs: 10_000 })

    expect(lock).not.toBeNull()
    expect(lock?.owner).toBe('a')
    expect(lock?.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('refuses a lock already held by someone else', async () => {
    await acquireLock('test:held', { owner: 'a', ttlMs: 10_000 })

    expect(await acquireLock('test:held', { owner: 'b', ttlMs: 10_000 })).toBeNull()
  })

  it('grants the lock to exactly one of many concurrent callers', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        acquireLock('test:race', { owner: `owner-${i}`, ttlMs: 10_000 }),
      ),
    )

    expect(attempts.filter((lock) => lock !== null)).toHaveLength(1)
  })

  it('lets a new owner steal an expired lock', async () => {
    // A TTL in the past: the lock is born already expired.
    await acquireLock('test:expired', { owner: 'a', ttlMs: -1000 })

    const stolen = await acquireLock('test:expired', { owner: 'b', ttlMs: 10_000 })

    expect(stolen?.owner).toBe('b')
  })
})

describe('releaseLock', () => {
  it('releases a lock held by the same owner', async () => {
    await acquireLock('test:release', { owner: 'a', ttlMs: 10_000 })

    expect(await releaseLock('test:release', 'a')).toBe(true)
    // Now free again.
    expect(await acquireLock('test:release', { owner: 'b', ttlMs: 10_000 })).not.toBeNull()
  })

  it('does not release a lock held by a different owner', async () => {
    await acquireLock('test:wrong-owner', { owner: 'a', ttlMs: 10_000 })

    expect(await releaseLock('test:wrong-owner', 'b')).toBe(false)
    // 'a' still holds it.
    expect(await acquireLock('test:wrong-owner', { owner: 'c', ttlMs: 10_000 })).toBeNull()
  })
})

describe('withLock', () => {
  it('runs the callback and releases afterwards', async () => {
    const result = await withLock('test:with', { owner: 'a', ttlMs: 10_000 }, async () => 'done')

    expect(result).toBe('done')
    expect(await db.select().from(locks)).toHaveLength(0)
  })

  it('releases the lock even when the callback throws', async () => {
    await expect(
      withLock('test:throws', { owner: 'a', ttlMs: 10_000 }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await db.select().from(locks)).toHaveLength(0)
  })

  it('throws LockUnavailableError when the lock is held', async () => {
    await acquireLock('test:contended', { owner: 'a', ttlMs: 10_000 })

    await expect(
      withLock('test:contended', { owner: 'b', ttlMs: 10_000 }, async () => 'never'),
    ).rejects.toBeInstanceOf(LockUnavailableError)
  })

  it('serializes work so only one caller enters the critical section', async () => {
    // This is the guarantee the per-task sync job depends on: a second job for the
    // same task must fail rather than run concurrently.
    let entered = 0

    const run = () =>
      withLock('test:critical', { ttlMs: 10_000 }, async () => {
        entered += 1
        await new Promise((resolve) => setTimeout(resolve, 50))
        return 'ok'
      })

    const results = await Promise.allSettled([run(), run()])

    expect(entered).toBe(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  })
})

describe('cleanupExpiredLocks', () => {
  it('removes only locks that expired beyond the grace period', async () => {
    await db.insert(locks).values([
      { key: 'stale', owner: 'a', expiresAt: sql`now() - interval '2 hours'` },
      {
        key: 'recently-expired',
        owner: 'b',
        expiresAt: sql`now() - interval '1 minute'`,
      },
      { key: 'live', owner: 'c', expiresAt: sql`now() + interval '1 hour'` },
    ])

    expect(await cleanupExpiredLocks(60 * 60 * 1000)).toBe(1)

    const remaining = (await db.select().from(locks)).map((row) => row.key).sort()
    expect(remaining).toEqual(['live', 'recently-expired'])
  })
})
