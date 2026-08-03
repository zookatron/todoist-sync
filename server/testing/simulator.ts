import { randomUUID } from 'node:crypto'
import type { RequestHandler } from 'msw'
import { setupServer, type SetupServer } from 'msw/node'
import { afterAll, beforeEach } from 'vitest'

export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/**
 * Owns the single msw server for the process.
 *
 * Handlers are registered under a per-simulator id and re-applied as a set whenever one
 * changes, so several simulators can be active at once and any one of them can be torn
 * down without disturbing the others. msw itself has no notion of handler ownership —
 * `resetHandlers(...)` replaces the whole list — which is what this bookkeeping works
 * around.
 */
class MockServiceWorker {
  private server: SetupServer = setupServer()
  private listening = false
  private handlers = new Map<string, RequestHandler[]>()

  setHandlers(id: string, handlers: RequestHandler[]): void {
    if (!this.listening) {
      // `error` rather than `warn` is the whole safety guarantee: a request no simulator
      // models fails the test loudly instead of leaving for the real API.
      this.server.listen({ onUnhandledRequest: 'error' })
      this.listening = true
    }

    this.handlers.set(id, handlers)
    this.apply()
  }

  removeHandlers(id: string): void {
    this.handlers.delete(id)
    this.apply()

    if (this.listening && this.handlers.size === 0) {
      this.server.close()
      this.listening = false
    }
  }

  private apply(): void {
    this.server.resetHandlers(...[...this.handlers.values()].flat())
  }
}

/**
 * Base for a stateful in-memory stand-in for an external HTTP API.
 *
 * A simulator holds real entity state and answers requests from it, so code under test
 * runs unmodified: no `vi.mock`, no injected repository, no pure-function extraction just
 * to make a code path reachable. Sequences that span several calls — create, then read
 * back, then observe the change on the next poll — behave the way they do in production.
 *
 * Constructing one registers vitest hooks, so instantiate it at the top level of a test
 * file (not inside `beforeEach`).
 */
export abstract class Simulator {
  private static msw = new MockServiceWorker()

  private readonly id = randomUUID()
  private readonly constantHandlers: RequestHandler[]

  constructor() {
    this.constantHandlers = this.handlers()
    this.resetHandlers()

    // Reset before each test rather than after: a test that throws part-way through still
    // leaves a clean world for the next one.
    beforeEach(() => {
      this.reset()
      this.resetHandlers()
    })

    afterAll(() => {
      this.close()
    })
  }

  /** The permanent handlers modelling this API. Called once, at construction. */
  protected abstract handlers(): RequestHandler[]

  /** Clears all simulated state. Override to reset your stores. */
  reset(): void {}

  /**
   * Overrides behaviour for the current test only — the way to exercise error paths
   * (a 429 driving `withRetry`'s backoff, a 500 mid-reconciliation) without teaching the
   * simulator to fail on demand. Undone by the next `beforeEach`.
   */
  useForTest(handlers: RequestHandler[]): void {
    // msw resolves with the *first* matching handler, so overrides go in front.
    Simulator.msw.setHandlers(this.id, [...handlers, ...this.constantHandlers])
  }

  resetHandlers(): void {
    Simulator.msw.setHandlers(this.id, this.constantHandlers)
  }

  close(): void {
    Simulator.msw.removeHandlers(this.id)
  }
}

/**
 * Merges `patch` into `base`, recursing into plain objects and replacing everything else.
 *
 * Lets seed helpers accept a deep partial over a fully-populated default, so a test names
 * only the fields it cares about.
 */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T

  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const existing = result[key]
    result[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value
  }
  return result as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
