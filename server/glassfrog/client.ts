import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { glassfrogIntegration } from '../db/schema/integrations.js'
import { logger } from '../logger.js'
import type { Client } from './generated/client/index.js'
import { createClient, createConfig } from './generated/client/index.js'
import type { Pagination } from './generated/types.gen.js'

export const GLASSFROG_BASE_URL = 'https://app.glassfrog.com/api/v5'

export class GlassfrogNotConnectedError extends Error {
  constructor(userId: string) {
    super(`User ${userId} has not saved a Glassfrog API key`)
    this.name = 'GlassfrogNotConnectedError'
  }
}

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

  if (!integration) throw new GlassfrogNotConnectedError(userId)

  return createGlassfrogClient(integration.apiKey)
}

type PaginatedResponse<T> = {
  data: T[]
  meta: { pagination: Pagination }
}

type PaginatedCall<T> = (options: {
  client: Client
  query: { cursor?: string; per_page?: number }
  throwOnError: true
}) => Promise<{ data: PaginatedResponse<T> }>

/**
 * Follows Glassfrog's cursor pagination to completion.
 *
 * Glassfrog offers no `updated_since` filter, so change detection means enumerating a
 * whole collection every poll — this helper is on the hot path. `per_page` defaults to
 * the API maximum-ish 100 to keep round trips down.
 *
 * `maxPages` is a runaway guard; hitting it is logged rather than silently truncating.
 */
export async function paginateAll<T>(
  call: PaginatedCall<T>,
  client: Client,
  options: { perPage?: number; maxPages?: number } = {},
): Promise<T[]> {
  const perPage = options.perPage ?? 100
  const maxPages = options.maxPages ?? 100

  const collected: T[] = []
  let cursor: string | undefined
  let page = 0

  do {
    const response = await withRetry(() =>
      call({
        client,
        query: cursor ? { cursor, per_page: perPage } : { per_page: perPage },
        throwOnError: true,
      }),
    )

    collected.push(...response.data.data)

    const pagination = response.data.meta.pagination
    cursor = pagination.has_next_page ? (pagination.next_cursor ?? undefined) : undefined
    page += 1

    if (page >= maxPages && cursor) {
      logger.warn(
        { pages: page, collected: collected.length },
        'Stopped paginating Glassfrog at the page limit; results are incomplete',
      )
      break
    }
  } while (cursor)

  return collected
}

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status
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
      logger.warn({ status, attempt, delay }, 'Glassfrog request failed; retrying')
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
