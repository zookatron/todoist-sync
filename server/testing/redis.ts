import type IORedis from 'ioredis'
import { afterAll, beforeEach } from 'vitest'
import { setConnection } from '../queue/queues.js'

type Entry = { value: string; ttlSeconds: number | null }

/**
 * An in-memory stand-in for the slice of Redis the app uses outside BullMQ: `MGET`, and a
 * pipeline of `SET key value EX seconds`. It records each key's TTL, so a test can assert on
 * how long something was cached for.
 *
 * Instantiate at the top level; the constructor registers the vitest hooks.
 */
export class RedisSimulator {
  private readonly entries = new Map<string, Entry>()

  constructor() {
    this.install()

    beforeEach(() => {
      this.entries.clear()
      this.install()
    })

    afterAll(() => {
      setConnection(null)
    })
  }

  /** The stored value, or undefined. */
  get(key: string): string | undefined {
    return this.entries.get(key)?.value
  }

  /** The TTL `key` was stored with, in seconds. Null if it has none. */
  ttl(key: string): number | null | undefined {
    return this.entries.get(key)?.ttlSeconds
  }

  /** Pre-populates a key, as if an earlier run had stored it. */
  seed(key: string, value: string, ttlSeconds: number | null = null): void {
    this.entries.set(key, { value, ttlSeconds })
  }

  /** Empties the store, as if every key had expired. */
  clear(): void {
    this.entries.clear()
  }

  get keys(): string[] {
    return [...this.entries.keys()]
  }

  private install(): void {
    const pipeline = () => {
      const commands: Array<() => void> = []
      const chain = {
        set: (key: string, value: string, mode?: string, ttl?: number) => {
          if (mode !== undefined && mode !== 'EX') throw new Error(`Unsupported SET mode ${mode}`)
          commands.push(() => this.entries.set(key, { value, ttlSeconds: ttl ?? null }))
          return chain
        },
        exec: () => {
          for (const command of commands) command()
          return Promise.resolve(commands.map(() => [null, 'OK']))
        },
      }
      return chain
    }

    setConnection({
      mget: (...keys: string[]) => Promise.resolve(keys.map((key) => this.get(key) ?? null)),
      pipeline,
    } as unknown as IORedis)
  }
}
