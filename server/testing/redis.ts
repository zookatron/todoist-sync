import type IORedis from 'ioredis'
import { afterAll, beforeEach } from 'vitest'
import { closeQueues, setConnection } from '../queue/queues.js'
import { createRedisMock } from './redis-mock.js'

/**
 * An in-memory Redis for the duration of a test file: ioredis-mock behind the app's
 * `getConnection()`. Everything that uses Redis runs on it unmodified — BullMQ itself, so the
 * real queues are built over it and a test enqueues and inspects jobs with the ordinary
 * `Queue` API:
 *
 * ```ts
 * const jobs = await getTaskQueue().getJobs(['wait'], 0, -1, true)
 * ```
 *
 * `client` is the same connection, for seeding and inspecting keys directly. It is
 * flushed before each test.
 *
 * Instantiate at the top level; the constructor registers the vitest hooks.
 */
export class RedisSimulator {
  readonly client: IORedis = createRedisMock()
  private readonly overridden = new Map<string, unknown>()

  constructor() {
    setConnection(this.client)

    beforeEach(async () => {
      this.restoreCommands()
      await this.client.flushall()
    })

    afterAll(async () => {
      await closeQueues()
      setConnection(null)
    })
  }

  /**
   * Makes `commands` fail for the current test only, as if Redis had gone away — how the
   * error paths get exercised. `pipeline` and `multi` fail at `exec`.
   */
  failForTest(...commands: string[]): void {
    const client = this.client as unknown as Record<string, (...args: unknown[]) => unknown>
    const error = () => Promise.reject(new Error('Connection is closed.'))

    for (const name of commands) {
      const original = client[name]!
      if (!this.overridden.has(name)) this.overridden.set(name, original)

      client[name] =
        name === 'pipeline' || name === 'multi'
          ? (...args) => Object.assign(original.apply(this.client, args) as object, { exec: error })
          : error
    }
  }

  private restoreCommands(): void {
    const client = this.client as unknown as Record<string, unknown>
    for (const [name, original] of this.overridden) client[name] = original
    this.overridden.clear()
  }
}
