import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const refreshAuthToken = vi.hoisted(() => vi.fn())
vi.mock('@doist/todoist-sdk', () => ({ refreshAuthToken }))

const { db, pool } = await import('../db/index.js')
const { todoistIntegration } = await import('../db/schema/integrations.js')
const { user } = await import('../db/schema/auth.js')
const { locks } = await import('../db/schema/locks.js')
const { getValidAccessToken, TodoistReauthRequiredError, TodoistNotConnectedError } =
  await import('./oauth.js')

const userId = `test-user-${randomUUID()}`

async function seedIntegration(overrides: Partial<typeof todoistIntegration.$inferInsert> = {}) {
  await db
    .insert(todoistIntegration)
    .values({
      userId,
      accessToken: 'stored-access-token',
      refreshToken: 'stored-refresh-token',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...overrides,
    })
    .onConflictDoUpdate({
      target: todoistIntegration.userId,
      set: {
        accessToken: 'stored-access-token',
        refreshToken: 'stored-refresh-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        needsReauth: null,
        ...overrides,
      },
    })
}

function readIntegration() {
  return db.query.todoistIntegration.findFirst({ where: eq(todoistIntegration.userId, userId) })
}

beforeEach(async () => {
  refreshAuthToken.mockReset()
  await db.delete(locks)
  await db.delete(todoistIntegration).where(eq(todoistIntegration.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.insert(user).values({
    id: userId,
    name: 'Test',
    email: `${userId}@example.com`,
    emailVerified: false,
  })
})

afterAll(async () => {
  await db.delete(todoistIntegration).where(eq(todoistIntegration.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(locks)
  await pool.end()
})

describe('getValidAccessToken', () => {
  it('throws when Todoist was never connected', async () => {
    await expect(getValidAccessToken(userId)).rejects.toBeInstanceOf(TodoistNotConnectedError)
  })

  it('returns the stored token without refreshing when it is still valid', async () => {
    await seedIntegration()

    expect(await getValidAccessToken(userId)).toBe('stored-access-token')
    expect(refreshAuthToken).not.toHaveBeenCalled()
  })

  it('refreshes when the token is inside the expiry skew window', async () => {
    // 30s from expiry: still "valid", but inside the 60s skew, so it must refresh.
    await seedIntegration({ expiresAt: new Date(Date.now() + 30_000) })
    refreshAuthToken.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresIn: 3600,
      tokenType: 'Bearer',
    })

    expect(await getValidAccessToken(userId)).toBe('new-access-token')
    expect(refreshAuthToken).toHaveBeenCalledTimes(1)
  })

  it('persists the ROTATED refresh token', async () => {
    // Todoist invalidates the old refresh token ~60s after use. Failing to store the
    // new one permanently breaks the connection.
    await seedIntegration({ expiresAt: new Date(Date.now() - 1000) })
    refreshAuthToken.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresIn: 3600,
      tokenType: 'Bearer',
    })

    await getValidAccessToken(userId)

    const stored = await readIntegration()
    expect(stored?.refreshToken).toBe('rotated-refresh-token')
    expect(stored?.accessToken).toBe('new-access-token')
    expect(stored?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_500_000)
  })

  it('keeps the existing refresh token when the response omits a new one', async () => {
    await seedIntegration({ expiresAt: new Date(Date.now() - 1000) })
    refreshAuthToken.mockResolvedValue({
      accessToken: 'new-access-token',
      expiresIn: 3600,
      tokenType: 'Bearer',
    })

    await getValidAccessToken(userId)

    expect((await readIntegration())?.refreshToken).toBe('stored-refresh-token')
  })

  it('refreshes only once across concurrent callers', async () => {
    // The reason refreshes take a lock: two simultaneous refreshes would spend the
    // rotation chain twice and disconnect the account.
    await seedIntegration({ expiresAt: new Date(Date.now() - 1000) })
    refreshAuthToken.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return {
        accessToken: 'new-access-token',
        refreshToken: 'rotated-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      }
    })

    const tokens = await Promise.all([
      getValidAccessToken(userId),
      getValidAccessToken(userId),
      getValidAccessToken(userId),
    ])

    expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    expect(tokens).toEqual(['new-access-token', 'new-access-token', 'new-access-token'])
  })

  it('marks the integration for re-auth when the refresh fails', async () => {
    await seedIntegration({ expiresAt: new Date(Date.now() - 1000) })
    refreshAuthToken.mockRejectedValue(new Error('invalid_grant'))

    await expect(getValidAccessToken(userId)).rejects.toBeInstanceOf(TodoistReauthRequiredError)
    expect((await readIntegration())?.needsReauth).toBeInstanceOf(Date)
  })

  it('refuses to use a connection already flagged for re-auth', async () => {
    await seedIntegration({ needsReauth: new Date() })

    await expect(getValidAccessToken(userId)).rejects.toBeInstanceOf(TodoistReauthRequiredError)
    expect(refreshAuthToken).not.toHaveBeenCalled()
  })

  it('returns long-lived legacy tokens as-is', async () => {
    // Older Todoist apps get a token with no expiry and no refresh token.
    await seedIntegration({ expiresAt: null, refreshToken: null })

    expect(await getValidAccessToken(userId)).toBe('stored-access-token')
    expect(refreshAuthToken).not.toHaveBeenCalled()
  })

  it('refreshes a seemingly-valid token when forced (after a 401)', async () => {
    await seedIntegration()
    refreshAuthToken.mockResolvedValue({
      accessToken: 'forced-token',
      refreshToken: 'rotated-refresh-token',
      expiresIn: 3600,
      tokenType: 'Bearer',
    })

    expect(await getValidAccessToken(userId, true)).toBe('forced-token')
    expect(refreshAuthToken).toHaveBeenCalledTimes(1)
  })
})
