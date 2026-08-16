import { randomUUID } from 'node:crypto'
import type { Permission } from '@doist/todoist-sdk'
import { refreshAuthToken, TodoistRequestError } from '@doist/todoist-sdk'
import { eq } from 'drizzle-orm'
import { createCookie } from 'react-router'
import { db } from '../db/index.js'
import { todoistIntegration } from '../db/schema/integrations.js'
import { env } from '../utils/env.js'
import { LockUnavailableError, withLock } from '../utils/lock.js'
import { logger, type Logger } from '../utils/logger.js'
import { withOAuthTrace } from './oauth-trace.js'
import { todoistTransport } from './transport.js'

/**
 * Scopes requested during authorization.
 *
 * - `data:read_write` — read and write tasks and projects
 * - `data:delete`     — delete tasks whose Glassfrog action is gone
 * - `project:delete`  — archive projects that no longer map to Glassfrog
 */
export const TODOIST_SCOPES: readonly Permission[] = [
  'data:read_write',
  'data:delete',
  'project:delete',
]

/**
 * Holds the OAuth `state` between the redirect out and the callback back.
 *
 * Signed and httpOnly: `state` is CSRF protection, so a value the browser could forge
 * would defeat the point. Short-lived because it only has to survive one round trip.
 */
export const todoistOAuthStateCookie = createCookie('todoist_oauth_state', {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
  maxAge: 60 * 10,
  secrets: [env.BETTER_AUTH_SECRET],
})

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

type IntegrationRow = Awaited<ReturnType<typeof loadIntegration>>

/**
 * The stored credential state.
 *
 * Every diagnosis of a rotation failure starts here: which refresh token a process was
 * holding, how stale its expiry bookkeeping was, and whether it had already been marked
 * for re-auth.
 */
function describeIntegration(row: IntegrationRow) {
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    msUntilExpiry: row.expiresAt ? row.expiresAt.getTime() - Date.now() : null,
    expiring: isExpiring(row.expiresAt),
    needsReauth: row.needsReauth?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  }
}

/** Pulls the status and body off a `TodoistRequestError`, which is where Todoist's own
 * explanation of the failure lives. Currently the single most useful missing datum: an
 * `invalid_grant` body means the refresh chain is genuinely broken, while a 5xx or a
 * network error means it is not and the token is still good. */
function describeRefreshError(error: unknown) {
  if (error instanceof TodoistRequestError) {
    return {
      kind: 'TodoistRequestError',
      httpStatusCode: error.httpStatusCode ?? null,
      isAuthenticationError: error.isAuthenticationError(),
      responseData: error.responseData,
    }
  }

  return {
    kind: error instanceof Error ? error.constructor.name : typeof error,
    httpStatusCode: null,
    isAuthenticationError: false,
    responseData: null,
  }
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
async function refreshAndPersist(
  userId: string,
  refreshToken: string,
  log: Logger,
): Promise<string> {
  const startedAt = Date.now()

  // The SDK sends exactly these four fields to the token endpoint, so logging them here
  // records the outgoing request even when the wire trace is off.
  log.info(
    {
      step: 'request',
      grantType: 'refresh_token',
      clientId: env.TODOIST_CLIENT_ID,
      clientSecret: env.TODOIST_CLIENT_SECRET,
      refreshToken,
      traceEnabled: env.TODOIST_HTTP_TRACE,
    },
    'Sending Todoist token refresh',
  )

  try {
    const refreshed = await refreshAuthToken(
      {
        clientId: env.TODOIST_CLIENT_ID,
        clientSecret: env.TODOIST_CLIENT_SECRET,
        refreshToken,
      },
      withOAuthTrace(todoistTransport(), log, env.TODOIST_HTTP_TRACE),
    )

    const rotated = Boolean(refreshed.refreshToken) && refreshed.refreshToken !== refreshToken
    const nextRefreshToken = refreshed.refreshToken ?? refreshToken
    const expiresAt = refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000) : null

    log.info(
      {
        step: 'response',
        durationMs: Date.now() - startedAt,
        accessToken: refreshed.accessToken,
        sentRefreshToken: refreshToken,
        receivedRefreshToken: refreshed.refreshToken ?? null,
        // The whole failure mode lives in these two flags: a rotation we fail to persist
        // is what silently breaks the chain for the next refresh.
        rotated,
        refreshTokenOmitted: !refreshed.refreshToken,
        expiresIn: refreshed.expiresIn ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
        tokenType: refreshed.tokenType ?? null,
        scope: refreshed.scope ?? null,
      },
      'Todoist token refresh succeeded',
    )

    const updated = await db
      .update(todoistIntegration)
      .set({
        accessToken: refreshed.accessToken,
        // The server may omit a new refresh token; keep the current one in that case.
        refreshToken: nextRefreshToken,
        expiresAt,
        needsReauth: null,
        updatedAt: new Date(),
      })
      .where(eq(todoistIntegration.userId, userId))
      .returning({ refreshToken: todoistIntegration.refreshToken })

    // Confirms the rotated token actually reached the database. If this ever disagrees
    // with `receivedRefreshToken`, the persist is the bug, not the API.
    log.info(
      {
        step: 'persisted',
        storedRefreshToken: updated[0]?.refreshToken ?? null,
        matchesReceived: updated[0]?.refreshToken === nextRefreshToken,
        rowsUpdated: updated.length,
      },
      'Persisted refreshed Todoist token',
    )

    return refreshed.accessToken
  } catch (error) {
    // The refresh chain is broken; only the user can fix it by reconnecting.
    await db
      .update(todoistIntegration)
      .set({ needsReauth: new Date(), updatedAt: new Date() })
      .where(eq(todoistIntegration.userId, userId))

    log.error(
      {
        step: 'failed',
        durationMs: Date.now() - startedAt,
        sentRefreshToken: refreshToken,
        ...describeRefreshError(error),
        err: error,
      },
      'Todoist token refresh failed; re-auth required',
    )
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
  // One id per call, carried onto every line below. With web and worker sharing a log
  // file, this is what lets you pick a single refresh out of two interleaved processes.
  const log = logger.child({
    userId,
    flow: 'todoist-token-refresh',
    traceId: randomUUID(),
    forceRefresh,
  })

  const integration = await loadIntegration(userId)

  log.debug({ step: 'loaded', ...describeIntegration(integration) }, 'Evaluating Todoist token')

  if (integration.needsReauth) {
    log.warn(
      { step: 'blocked', needsReauth: integration.needsReauth.toISOString() },
      'Todoist token already marked as needing re-auth',
    )
    throw new TodoistReauthRequiredError(userId)
  }

  if (!forceRefresh && !isExpiring(integration.expiresAt)) {
    log.debug({ step: 'reused' }, 'Stored Todoist access token is still current')
    return integration.accessToken
  }

  if (!integration.refreshToken) {
    // A long-lived token that the server rejected: nothing to refresh with.
    log.warn(
      { step: 'no-refresh-token' },
      forceRefresh
        ? 'Todoist rejected a long-lived token and there is nothing to refresh with'
        : 'Todoist token is expiring but no refresh token is stored',
    )
    if (forceRefresh) throw new TodoistReauthRequiredError(userId)
    return integration.accessToken
  }

  const refreshToken = integration.refreshToken

  try {
    return await withLock(
      `todoist-token:${userId}`,
      { owner: `refresh:${userId}`, ttlMs: REFRESH_LOCK_TTL_MS },
      async () => {
        log.debug({ step: 'lock-acquired' }, 'Holding the Todoist refresh lock')

        // Re-read inside the lock: another process may have just refreshed, in which
        // case our `refreshToken` is already spent.
        const current = await loadIntegration(userId)

        // A mismatch here means someone rotated the token between our first read and the
        // lock, and proceeding with the pre-lock value would spend a dead token.
        const changedUnderUs = current.refreshToken !== integration.refreshToken

        log.debug(
          {
            step: 're-read',
            changedUnderUs,
            beforeLock: integration.refreshToken,
            afterLock: current.refreshToken,
            ...describeIntegration(current),
          },
          'Re-read Todoist integration inside the refresh lock',
        )

        if (!forceRefresh && !isExpiring(current.expiresAt)) {
          log.info(
            { step: 'refreshed-by-other' },
            'Another process refreshed the Todoist token while we waited',
          )
          return current.accessToken
        }

        return refreshAndPersist(userId, current.refreshToken ?? refreshToken, log)
      },
    )
  } catch (error) {
    if (!(error instanceof LockUnavailableError)) throw error

    // Someone else is refreshing right now. Wait for them rather than competing.
    log.info(
      { step: 'lock-unavailable' },
      'Another process holds the Todoist refresh lock; waiting for it',
    )
    return waitForConcurrentRefresh(userId, log)
  }
}

/**
 * Polls for the token another process is currently refreshing.
 *
 * Bounded: if the holder crashes, its lock expires and the next caller refreshes.
 */
async function waitForConcurrentRefresh(userId: string, log: Logger): Promise<string> {
  const attempts = 10
  const delayMs = 500

  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))

    const current = await loadIntegration(userId)

    log.debug(
      { step: 'waiting', attempt: attempt + 1, attempts, ...describeIntegration(current) },
      'Polling for a concurrent Todoist token refresh',
    )

    if (current.needsReauth) {
      log.warn(
        { step: 'wait-failed', attempt: attempt + 1 },
        'The concurrent Todoist refresh failed and marked the integration for re-auth',
      )
      throw new TodoistReauthRequiredError(userId)
    }

    if (!isExpiring(current.expiresAt)) {
      log.info(
        { step: 'wait-succeeded', attempt: attempt + 1, ...describeIntegration(current) },
        'Picked up the token from a concurrent Todoist refresh',
      )
      return current.accessToken
    }
  }

  // The lock holder neither finished nor marked re-auth — it most likely died mid-refresh,
  // which is exactly the case where a rotated token can be lost.
  log.error(
    { step: 'wait-timeout', attempts, waitedMs: attempts * delayMs },
    'Timed out waiting for a concurrent Todoist token refresh',
  )
  throw new Error(`Timed out waiting for a concurrent Todoist token refresh (user ${userId})`)
}
