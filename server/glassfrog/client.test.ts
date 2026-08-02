import { describe, expect, it, vi } from 'vitest'
import { createGlassfrogClient, GLASSFROG_BASE_URL, paginateAll, withRetry } from './client.js'
import type { Client } from './generated/client/index.js'
import { getMe, listMyActions } from './generated/sdk.gen.js'

type Recorded = { url: string; headers: Record<string, string> }

/** Builds a client whose fetch is stubbed with the given sequence of responses. */
function stubClient(responder: (request: Request) => Response): {
  client: Client
  requests: Recorded[]
} {
  const requests: Recorded[] = []
  const client = createGlassfrogClient('test-key-123')

  client.setConfig({
    ...client.getConfig(),
    // The generated client always calls fetch with a Request; the wider DOM signature
    // is narrowed here so the stub can read url/headers directly.
    fetch: async (input: RequestInfo | URL) => {
      const request = input as Request
      requests.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()) })
      return responder(request)
    },
  })

  return { client, requests }
}

function jsonPage(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createGlassfrogClient', () => {
  it('targets the absolute v5 base URL and authenticates with X-Auth-Token', async () => {
    // The generated client defaults to the spec's relative `/api/v5` server, which
    // would resolve against localhost at runtime.
    const { client, requests } = stubClient(() => jsonPage({ data: {} }))

    await getMe({ client })

    expect(requests[0]?.url).toBe(`${GLASSFROG_BASE_URL}/me`)
    expect(requests[0]?.headers['x-auth-token']).toBe('test-key-123')
  })
})

describe('paginateAll', () => {
  /** Drives real pagination through the generated /me/actions endpoint. */
  const listActions = (client: Client) =>
    paginateAll<{ id: string }>(async ({ cursor, perPage }) => {
      const response = await listMyActions({
        client,
        query: { cursor, per_page: perPage },
        throwOnError: true,
      })
      return response.data
    })

  it('follows next_cursor until the last page and concatenates results', async () => {
    const pages = [
      {
        data: [{ id: 'a' }, { id: 'b' }],
        meta: { pagination: { per_page: 2, has_next_page: true, next_cursor: 'cursor-2' } },
      },
      {
        data: [{ id: 'c' }],
        meta: { pagination: { per_page: 2, has_next_page: false } },
      },
    ]
    let call = 0
    const { client, requests } = stubClient(() => jsonPage(pages[call++]))

    const results = await listActions(client)

    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toContain('per_page=100')
    expect(requests[0]?.url).not.toContain('cursor=')
    expect(requests[1]?.url).toContain('cursor=cursor-2')
  })

  it('stops at a single page when there is no next cursor', async () => {
    const { client, requests } = stubClient(() =>
      jsonPage({
        data: [{ id: 'only' }],
        meta: { pagination: { per_page: 100, has_next_page: false } },
      }),
    )

    expect(await listActions(client)).toHaveLength(1)
    expect(requests).toHaveLength(1)
  })

  it('stops at maxPages rather than looping forever on a broken cursor', async () => {
    // A server that always claims another page would otherwise spin indefinitely.
    let calls = 0
    const results = await paginateAll<{ id: string }>(
      async () => {
        calls += 1
        return {
          data: [{ id: 'x' }],
          meta: { pagination: { per_page: 1, has_next_page: true, next_cursor: 'always' } },
        }
      },
      { maxPages: 3 },
    )

    expect(calls).toBe(3)
    expect(results).toHaveLength(3)
  })
})

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok')

    expect(await withRetry(fn)).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry client errors', async () => {
    // A 401 or 404 will never succeed on retry; failing fast surfaces it sooner.
    const fn = vi.fn().mockRejectedValue({ status: 401 })

    await expect(withRetry(fn, 3)).rejects.toMatchObject({ status: 401 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries rate limiting and gives up after maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 429 })
    vi.useFakeTimers()

    const promise = withRetry(fn, 2).catch((error) => error)
    await vi.runAllTimersAsync()
    await promise
    vi.useRealTimers()

    // Initial attempt plus two retries.
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('recovers when a transient server error resolves', async () => {
    const fn = vi.fn().mockRejectedValueOnce({ status: 503 }).mockResolvedValue('recovered')
    vi.useFakeTimers()

    const promise = withRetry(fn)
    await vi.runAllTimersAsync()

    expect(await promise).toBe('recovered')
    vi.useRealTimers()
  })
})
