import { eq } from 'drizzle-orm'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { db } from '../db/index.js'
import { todoistIntegration } from '../db/schema/integrations.js'
import {
  connectedUser,
  DatabaseSimulator,
  TODOIST_TEST_ACCESS_TOKEN,
  TODOIST_TEST_REFRESH_TOKEN,
  TodoistSimulator,
} from '../testing/index.js'
import {
  getValidAccessToken,
  TodoistNotConnectedError,
  TodoistReauthRequiredError,
} from './oauth.js'

/**
 * Refresh-token rotation, against a Todoist that actually rotates.
 *
 * Previously this file mocked `@doist/todoist-sdk` outright, which meant the assertion
 * "we persisted the rotated token" only ever checked that we stored whatever the mock
 * returned. Here the simulator invalidates the old refresh token the moment it is spent,
 * exactly as Todoist does — so losing a rotation fails the test instead of passing it.
 */
new DatabaseSimulator()
const todoist = new TodoistSimulator()

const OAUTH_TOKEN_URL = 'https://todoist.com/oauth/access_token'

async function connect(overrides: Partial<typeof todoistIntegration.$inferInsert> = {}) {
  const { user } = await connectedUser()
  if (Object.keys(overrides).length > 0) {
    await db.update(todoistIntegration).set(overrides).where(eq(todoistIntegration.userId, user.id))
  }
  return user.id
}

function readIntegration(userId: string) {
  return db.query.todoistIntegration.findFirst({ where: eq(todoistIntegration.userId, userId) })
}

describe('getValidAccessToken', () => {
  it('throws when Todoist was never connected', async () => {
    await expect(getValidAccessToken('nobody')).rejects.toBeInstanceOf(TodoistNotConnectedError)
  })

  it('returns the stored token without refreshing when it is still valid', async () => {
    const userId = await connect({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) })

    expect(await getValidAccessToken(userId)).toBe(TODOIST_TEST_ACCESS_TOKEN)
    // Unspent, so no refresh happened.
    expect(todoist.isRefreshTokenValid(TODOIST_TEST_REFRESH_TOKEN)).toBe(true)
  })

  it('refreshes when the token is inside the expiry skew window', async () => {
    // 30s from expiry: still "valid", but inside the 60s skew, so it must refresh.
    const userId = await connect({ expiresAt: new Date(Date.now() + 30_000) })

    expect(await getValidAccessToken(userId)).toBe('access-token-1')
  })

  it('persists the ROTATED refresh token', async () => {
    const userId = await connect({ expiresAt: new Date(Date.now() - 1000) })

    await getValidAccessToken(userId)

    const stored = await readIntegration(userId)
    expect(stored?.accessToken).toBe('access-token-1')
    expect(stored?.refreshToken).toBe('refresh-token-1')
    expect(stored?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_500_000)

    // The old one is dead upstream. Had we kept it, the next refresh would fail.
    expect(todoist.isRefreshTokenValid(TODOIST_TEST_REFRESH_TOKEN)).toBe(false)
  })

  it('can refresh again using the rotated token', async () => {
    const userId = await connect({ expiresAt: new Date(Date.now() - 1000) })

    await getValidAccessToken(userId)
    await db
      .update(todoistIntegration)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(todoistIntegration.userId, userId))

    // Only possible if the first rotation was stored correctly.
    expect(await getValidAccessToken(userId)).toBe('access-token-2')
  })

  it('keeps the existing refresh token when the response omits a new one', async () => {
    const userId = await connect({ expiresAt: new Date(Date.now() - 1000) })
    todoist.useForTest([
      http.post(OAUTH_TOKEN_URL, () =>
        HttpResponse.json({
          access_token: 'access-without-rotation',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      ),
    ])

    await getValidAccessToken(userId)

    expect((await readIntegration(userId))?.refreshToken).toBe(TODOIST_TEST_REFRESH_TOKEN)
  })

  it('refreshes only once across concurrent callers', async () => {
    // The reason refreshes take a lock: two simultaneous refreshes would spend the
    // rotation chain twice and disconnect the account.
    const userId = await connect({ expiresAt: new Date(Date.now() - 1000) })

    const tokens = await Promise.all([
      getValidAccessToken(userId),
      getValidAccessToken(userId),
      getValidAccessToken(userId),
    ])

    expect(tokens).toEqual(['access-token-1', 'access-token-1', 'access-token-1'])
    // A second rotation would have minted refresh-token-2.
    expect((await readIntegration(userId))?.refreshToken).toBe('refresh-token-1')
  })

  it('marks the integration for re-auth when the refresh fails', async () => {
    const userId = await connect({ expiresAt: new Date(Date.now() - 1000) })
    todoist.useForTest([
      http.post(OAUTH_TOKEN_URL, () =>
        HttpResponse.json({ error: 'invalid_grant' }, { status: 401 }),
      ),
    ])

    await expect(getValidAccessToken(userId)).rejects.toBeInstanceOf(TodoistReauthRequiredError)
    expect((await readIntegration(userId))?.needsReauth).toBeInstanceOf(Date)
  })

  it('refuses to use a connection already flagged for re-auth', async () => {
    const userId = await connect({ needsReauth: new Date() })

    await expect(getValidAccessToken(userId)).rejects.toBeInstanceOf(TodoistReauthRequiredError)
    expect(todoist.isRefreshTokenValid(TODOIST_TEST_REFRESH_TOKEN)).toBe(true)
  })

  it('returns long-lived legacy tokens as-is', async () => {
    // Older Todoist apps get a token with no expiry and no refresh token.
    const userId = await connect({ expiresAt: null, refreshToken: null })

    expect(await getValidAccessToken(userId)).toBe(TODOIST_TEST_ACCESS_TOKEN)
  })

  it('refreshes a seemingly-valid token when forced (after a 401)', async () => {
    const userId = await connect({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) })

    expect(await getValidAccessToken(userId, true)).toBe('access-token-1')
  })
})
