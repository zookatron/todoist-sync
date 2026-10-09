import { logger } from './logger.js'
import { currentSyncContext } from './sync-context.js'

/** Bodies are cut here so one pathological response cannot flood the log. */
const MAX_BODY_CHARS = 8_000

type Service = 'glassfrog' | 'todoist'

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS
    ? `${text.slice(0, MAX_BODY_CHARS)}… [${text.length - MAX_BODY_CHARS} more chars]`
    : text
}

function headersToObject(headers: unknown): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers as [string, string][])
  return { ...(headers as Record<string, string>) }
}

async function readBody(source: { text(): Promise<string> } | undefined): Promise<string | null> {
  try {
    return source ? truncate(await source.text()) : null
  } catch (error) {
    return `<unreadable: ${error instanceof Error ? error.message : String(error)}>`
  }
}

function describeInitBody(body: unknown): string | null {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') return truncate(body)
  if (body instanceof URLSearchParams) return truncate(body.toString())
  return `<${Object.prototype.toString.call(body)}>`
}

type FetchLike = (input: never, init?: never) => Promise<unknown>

/**
 * Wraps a fetch so that every failed exchange is logged with its exact request and
 * response, tagged with the sync phase that issued it (see `sync-context.ts`).
 *
 * Successful calls are left alone and cost nothing: the response body is only read, via a
 * clone, once the status says it failed. The caller always receives the original response.
 * Headers are logged as sent, tokens included — see the logging note in CLAUDE.md.
 *
 * Two call shapes are supported because the two clients differ: the generated Glassfrog
 * client calls `fetch(Request)`, the Todoist SDK calls `customFetch(url, init)`.
 */
export function tracedFetch<F extends FetchLike>(service: Service, inner: () => F): F {
  const traced = async (input: Request | string, init?: RequestInit) => {
    const startedAt = Date.now()
    const isRequest = typeof input !== 'string'

    // Snapshot the request before sending: a Request body can only be consumed once.
    const request = {
      method: isRequest ? input.method : (init?.method ?? 'GET'),
      url: isRequest ? input.url : input,
      headers: headersToObject(isRequest ? input.headers : init?.headers),
      body: isRequest ? ((await readBody(input.clone())) ?? null) : describeInitBody(init?.body),
    }

    let response: Response & { clone?: () => Response }
    try {
      response = await (inner() as unknown as (...args: unknown[]) => Promise<Response>)(
        ...(isRequest ? [input] : [input, init]),
      )
    } catch (error) {
      logger.error(
        {
          service,
          ...currentSyncContext(),
          request,
          durationMs: Date.now() - startedAt,
          err: error,
        },
        `${service} request never got a response: ${request.method} ${request.url}`,
      )
      throw error
    }

    if (!response.ok) {
      // Todoist's custom-fetch responses are not always real Responses, so cloning is
      // best effort; without it the body is simply not recorded.
      const copy = typeof response.clone === 'function' ? response.clone() : undefined
      const headers =
        response.headers instanceof Headers
          ? Object.fromEntries(response.headers.entries())
          : { ...(response.headers as unknown as Record<string, string>) }

      logger[response.status === 404 ? 'warn' : 'error'](
        {
          service,
          ...currentSyncContext(),
          request,
          response: {
            status: response.status,
            statusText: response.statusText,
            headers,
            body: await readBody(copy),
          },
          durationMs: Date.now() - startedAt,
        },
        `${service} responded ${response.status} to ${request.method} ${request.url}`,
      )
    }

    return response
  }

  return traced as unknown as F
}
