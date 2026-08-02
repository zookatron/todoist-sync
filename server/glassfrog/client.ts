import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { glassfrogIntegration } from '../db/schema/integrations.js'
import { logger } from '../logger.js'
import type { Client } from './generated/client/index.js'
import { createClient, createConfig } from './generated/client/index.js'
import type { Pagination } from './generated/types.gen.js'

export const GLASSFROG_BASE_URL = 'https://app.glassfrog.com/api/v5'

/**
 * Builds a client authenticated with a specific key.
 *
 * The generated client defaults to the spec's relative `/api/v5` server, so the absolute
 * base URL has to be supplied here.
 *
 * Glassfrog v5 keys are static: no expiry, no scopes, no refresh. `X-Auth-Token` takes
 * precedence over `Authorization` server-side, so we use it exclusively.
 */
export function createGlassfrogClient(apiKey: string): Client {
  return createClient(
    createConfig({
      baseUrl: GLASSFROG_BASE_URL,
      headers: { 'X-Auth-Token': apiKey },
    }),
  )
}

/** Builds a client from the user's stored (encrypted) key. */
export async function getGlassfrogClient(userId: string): Promise<Client> {
  const integration = await db.query.glassfrogIntegration.findFirst({
    where: eq(glassfrogIntegration.userId, userId),
  })

  if (!integration) throw new Error(`User ${userId} has not saved a Glassfrog API key`)

  return createGlassfrogClient(integration.apiKey)
}

/** The envelope every Glassfrog list endpoint returns. */
export type PageEnvelope<T> = {
  data: T[]
  meta: { pagination: Pagination }
}

/**
 * Follows Glassfrog's cursor pagination to completion.
 *
 * Takes a page fetcher rather than a generated function directly, because list endpoints
 * differ in their path parameters (`/me/actions` versus `/roles/{role_id}/actions`).
 * Callers close over whatever the endpoint needs:
 *
 * ```ts
 * await paginateAll<Role>(async ({ cursor, perPage }) => {
 *   const response = await listMyRoles({
 *     client, query: { cursor, per_page: perPage }, throwOnError: true,
 *   })
 *   return response.data
 * })
 * ```
 *
 * Glassfrog offers no `updated_since` filter, so change detection means enumerating a
 * whole collection every poll — this is on the hot path.
 *
 * `maxPages` is a runaway guard. Hitting it throws rather than returning a partial
 * collection: callers diff these results against Todoist, so a silent truncation would
 * read as "the rest was deleted upstream" and prune live data.
 */
export async function paginateAll<T>(
  fetchPage: (params: { cursor?: string; perPage: number }) => Promise<PageEnvelope<T>>,
  options: { perPage?: number; maxPages?: number } = {},
): Promise<T[]> {
  const perPage = options.perPage ?? 100
  const maxPages = options.maxPages ?? 100

  const collected: T[] = []
  let cursor: string | undefined
  let page = 0

  do {
    const envelope = await withRetry(() => fetchPage({ cursor, perPage }))

    collected.push(...envelope.data)

    const pagination = envelope.meta.pagination
    cursor = pagination.has_next_page ? (pagination.next_cursor ?? undefined) : undefined
    page += 1

    if (page >= maxPages && cursor) {
      throw new Error('Hit Glassfrog pagination limit, unable to retrieve all results')
    }
  } while (cursor)

  return collected
}

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = error.status
    if (typeof status === 'number') return status
  }
  // hey-api throws the raw Response on throwOnError when the body is not JSON.
  if (error instanceof Response) return error.status
  return undefined
}

/**
 * Retries a Glassfrog call on rate limiting and transient server errors.
 *
 * Glassfrog v5 is beta and does not document a Retry-After header, so this backs off
 * exponentially rather than trusting one.
 */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const status = statusOf(error)
      const isRetryable = status === 429 || (status !== undefined && status >= 500)

      if (!isRetryable || attempt >= maxRetries) throw error

      const delay = Math.min(30_000, 1000 * 2 ** attempt)
      logger.warn(
        { status, attempt, delay },
        `Glassfrog request failed with status ${status}; retrying`,
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
