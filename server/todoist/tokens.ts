import { refreshAuthToken } from '@doist/todoist-sdk'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { todoistIntegration } from '../db/schema/integrations.js'
import { env } from '../env.js'
import { LockUnavailableError, withLock } from '../lock.js'
import { logger } from '../logger.js'

/** Refresh this long before actual expiry, to avoid racing the clock mid-request. */
const REFRESH_SKEW_MS = 60_000

const REFRESH_LOCK_TTL_MS = 30_000

export class TodoistNotConnectedError extends Error {
  constructor(userId: string) {
    super(`User ${userId} has not connected Todoist`)
    this.name = 'TodoistNotConnectedError'
  }
}

export class TodoistReauthRequiredError extends Error {
  constructor(userId: string) {
    super(`Todoist connection for user ${userId} needs to be re-authorized`)
    this.name = 'TodoistReauthRequiredError'
  }
}

function isExpiring(expiresAt: Date | null, skewMs = REFRESH_SKEW_MS): boolean {
  if (!expiresAt) return false // legacy long-lived token
  return expiresAt.getTime() - Date.now() <= skewMs
}

async function loadIntegration(userId: string) {
  const row = await db.query.todoistIntegration.findFirst({
    where: eq(todoistIntegration.userId, userId),
  })

  if (!row) throw new TodoistNotConnectedError(userId)
  return row
}

/**
 * Performs the refresh and persists the result. Must only be called while holding the
 * token lock.
 *
 * Todoist ROTATES the refresh token on every refresh, and the old one stops working
 * after a ~60s grace period. Persisting the new `refreshToken` is therefore not
 * optional — losing it permanently breaks the connection and forces the user to
 * reconnect by hand.
 */
async function refreshAndPersist(userId: string, refreshToken: string): Promise<string> {
  try {
    const refreshed = await refreshAuthToken({
      clientId: env.TODOIST_CLIENT_ID,
      clientSecret: env.TODOIST_CLIENT_SECRET,
      refreshToken,
    })

    await db
      .update(todoistIntegration)
      .set({
        accessToken: refreshed.accessToken,
        // The server may omit a new refresh token; keep the current one in that case.
        refreshToken: refreshed.refreshToken ?? refreshToken,
        expiresAt: refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000) : null,
        needsReauth: null,
        updatedAt: new Date(),
      })
      .where(eq(todoistIntegration.userId, userId))

    logger.info({ userId }, 'Refreshed Todoist access token')
    return refreshed.accessToken
  } catch (error) {
    // The refresh chain is broken; only the user can fix it by reconnecting.
    await db
      .update(todoistIntegration)
      .set({ needsReauth: new Date(), updatedAt: new Date() })
      .where(eq(todoistIntegration.userId, userId))

    logger.error({ userId, err: error }, 'Todoist token refresh failed; re-auth required')
    throw new TodoistReauthRequiredError(userId)
  }
}

/**
 * Returns a usable Todoist access token, refreshing it first if needed.
 *
 * **This is the only supported way to obtain a token.** Reading the column directly
 * skips expiry handling and, worse, can run two refreshes concurrently — which burns the
 * rotation chain and disconnects the account.
 *
 * @param forceRefresh refresh even if the stored token looks current. Used after a 401,
 * where the server disagrees with our expiry bookkeeping.
 */
export async function getValidAccessToken(userId: string, forceRefresh = false): Promise<string> {
  const integration = await loadIntegration(userId)

  if (integration.needsReauth) throw new TodoistReauthRequiredError(userId)

  if (!forceRefresh && !isExpiring(integration.expiresAt)) {
    return integration.accessToken
  }

  if (!integration.refreshToken) {
    // A long-lived token that the server rejected: nothing to refresh with.
    if (forceRefresh) throw new TodoistReauthRequiredError(userId)
    return integration.accessToken
  }

  const refreshToken = integration.refreshToken

  try {
    return await withLock(
      `todoist-token:${userId}`,
      { owner: `refresh:${userId}`, ttlMs: REFRESH_LOCK_TTL_MS },
      async () => {
        // Re-read inside the lock: another process may have just refreshed, in which
        // case our `refreshToken` is already spent.
        const current = await loadIntegration(userId)

        if (!forceRefresh && !isExpiring(current.expiresAt)) {
          return current.accessToken
        }

        return refreshAndPersist(userId, current.refreshToken ?? refreshToken)
      },
    )
  } catch (error) {
    if (!(error instanceof LockUnavailableError)) throw error

    // Someone else is refreshing right now. Wait for them rather than competing.
    return waitForConcurrentRefresh(userId)
  }
}

/**
 * Polls for the token another process is currently refreshing.
 *
 * Bounded: if the holder crashes, its lock expires and the next caller refreshes.
 */
async function waitForConcurrentRefresh(userId: string): Promise<string> {
  const attempts = 10
  const delayMs = 500

  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))

    const current = await loadIntegration(userId)
    if (current.needsReauth) throw new TodoistReauthRequiredError(userId)
    if (!isExpiring(current.expiresAt)) return current.accessToken
  }

  throw new Error(`Timed out waiting for a concurrent Todoist token refresh (user ${userId})`)
}
