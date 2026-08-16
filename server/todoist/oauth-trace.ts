import type { AuthOptions, CustomFetch, CustomFetchResponse } from '@doist/todoist-sdk'
import type { Logger } from '../utils/logger.js'

/** Parses a body for logging, falling back to the raw string when it is not JSON. */
function describeBody(raw: string | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}

  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers)

  return Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase(), value]))
}

function bodyToString(body: BodyInit | null | undefined): string | undefined {
  if (typeof body === 'string') return body
  if (body === null || body === undefined) return undefined
  return undefined // streams and form data are not used by the token endpoint
}

/**
 * Wraps the token-endpoint request so the exact bytes on the wire land in the log.
 *
 * `underlying` is whatever transport is already configured — the test `customFetch` when
 * one is installed, otherwise the platform `fetch`. Note the fallback: the SDK would
 * normally use npm-undici's `fetch` paired with its own dispatcher, and this replaces that
 * for the traced request. Global `fetch` with no dispatcher is a self-consistent pairing
 * (it is what the SDK itself falls back to off Node), but it is a different code path,
 * which is why tracing is opt-in rather than always on.
 */
function tracingFetch(log: Logger, underlying: CustomFetch): CustomFetch {
  return async (url, options) => {
    const startedAt = Date.now()
    const requestBody = bodyToString(options?.body)

    log.info(
      {
        http: 'request',
        url,
        method: options?.method ?? 'GET',
        headers: headersToObject(options?.headers),
        body: describeBody(requestBody),
        timeout: options?.timeout,
      },
      'Todoist token endpoint request',
    )

    let response: CustomFetchResponse
    try {
      response = await underlying(url, options)
    } catch (error) {
      log.error(
        { http: 'transport-error', url, durationMs: Date.now() - startedAt, err: error },
        'Todoist token endpoint request threw before a response',
      )
      throw error
    }

    // Read once, then hand the buffered copy to the SDK — a body can only be consumed one
    // time, and logging it must not be what consumes it.
    const text = await response.text()

    log.info(
      {
        http: 'response',
        url,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: response.headers,
        body: describeBody(text),
        durationMs: Date.now() - startedAt,
      },
      'Todoist token endpoint response',
    )

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(JSON.parse(text) as unknown),
    }
  }
}

/**
 * Auth options with wire tracing layered on top of the configured transport.
 *
 * Returns `base` untouched when tracing is off, so the default production path keeps the
 * SDK's own transport exactly as it was.
 */
export function withOAuthTrace(base: AuthOptions, log: Logger, enabled: boolean): AuthOptions {
  if (!enabled) return base

  const underlying: CustomFetch =
    base.customFetch ??
    (async (url, options) => {
      const response = await fetch(url, options)
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        text: () => response.text(),
        json: () => response.json(),
      }
    })

  return { ...base, customFetch: tracingFetch(log, underlying) }
}
