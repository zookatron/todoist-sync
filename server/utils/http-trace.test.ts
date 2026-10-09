import { afterEach, describe, expect, it, vi } from 'vitest'
import { tracedFetch } from './http-trace.js'
import { logger } from './logger.js'
import { phaseOf, withPhase } from './sync-context.js'

afterEach(() => vi.restoreAllMocks())

describe('tracedFetch', () => {
  it('logs request, response and sync phase for a failed Request-style call', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const fetchStub = vi.fn(() =>
      Promise.resolve(new Response('{"error":"nope"}', { status: 403 })),
    )
    const traced = tracedFetch('glassfrog', () => fetchStub as unknown as typeof fetch)

    const request = new Request('https://example.test/api/v5/roles/1/projects', {
      method: 'POST',
      headers: { 'X-Auth-Token': 'secret' },
      body: '{"name":"x"}',
    })

    const response = await withPhase('apply-create-glassfrog', () => traced(request), {
      userId: 'u1',
    })

    // The caller still gets an unconsumed response.
    expect(await response.text()).toBe('{"error":"nope"}')
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      service: 'glassfrog',
      phase: 'apply-create-glassfrog',
      userId: 'u1',
      request: {
        method: 'POST',
        url: 'https://example.test/api/v5/roles/1/projects',
        body: '{"name":"x"}',
        headers: { 'x-auth-token': 'secret' },
      },
      response: { status: 403, body: '{"error":"nope"}' },
    })
  })

  it('logs a 404 at warn and stays silent on success', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const responses = [new Response('', { status: 404 }), new Response('ok')]
    const traced = tracedFetch(
      'todoist',
      () => (_url: string) => Promise.resolve(responses.shift() as Response),
    )

    await traced('https://example.test/a')
    await traced('https://example.test/b')

    expect(warn).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
  })

  it('logs a transport failure and rethrows', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const traced = tracedFetch(
      'todoist',
      () => (_url: string) => Promise.reject<Response>(new Error('ECONNRESET')),
    )

    await expect(traced('https://example.test/a')).rejects.toThrow('ECONNRESET')
    expect(error.mock.calls[0]?.[0]).toMatchObject({ request: { url: 'https://example.test/a' } })
  })
})

describe('withPhase', () => {
  it('tags an error with the innermost phase and nests the path', async () => {
    const caught = await withPhase('poll', () =>
      withPhase('hierarchy', () => Promise.reject(new Error('boom'))),
    ).catch((e: unknown) => e)

    expect(phaseOf(caught)).toBe('poll > hierarchy')
  })
})
