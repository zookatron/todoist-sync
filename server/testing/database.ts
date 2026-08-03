import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { type Database, schema, setDatabase } from '../db/index.js'
import { resetSequences } from './factories/sequence.js'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

/**
 * An in-memory Postgres for the duration of a test file.
 *
 * PGlite is real Postgres compiled to WebAssembly, not a reimplementation, so the actual
 * migrations in `drizzle/` apply unchanged and the behaviour the sync code depends on is
 * the real behaviour: `ON CONFLICT … DO UPDATE … WHERE` returning no row under contention
 * (which is how `acquireLock` detects a held lock), `now() + …::interval` arithmetic,
 * partial unique indexes, `gen_random_uuid()`, `jsonb`. A schema change that breaks a
 * query breaks a test rather than slipping through to production.
 *
 * Instantiate at the top level of a test file; the constructor registers the vitest hooks.
 * Each file gets its own instance, so files are independent and can run in parallel.
 */
export class DatabaseSimulator {
  private client?: PGlite
  private database?: Database
  private truncateStatement?: string

  constructor() {
    beforeAll(async () => {
      await this.start()
    })
    beforeEach(async () => {
      await this.reset()
    })
    afterAll(async () => {
      await this.stop()
    })
  }

  /** The live database. Use it to seed directly or to assert on rows after an action. */
  get db(): Database {
    if (!this.database) {
      throw new Error('DatabaseSimulator is not started yet — use it inside a test, not at import')
    }
    return this.database
  }

  private async start(): Promise<void> {
    this.client = new PGlite()
    this.database = drizzle(this.client, { schema })

    await migrate(this.database as Parameters<typeof migrate>[0], {
      migrationsFolder: MIGRATIONS_FOLDER,
    })

    // Discovered rather than hard-coded so a new table is covered the moment its migration
    // lands, even if nothing cascades to it. Queried through PGlite directly: `Database` is
    // driver-agnostic, so `execute` has no useful row type on it.
    const tables = await this.client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    )
    const names = tables.rows.map((row) => `"${row.tablename}"`).join(', ')
    this.truncateStatement = `truncate ${names} restart identity cascade`

    setDatabase(this.database)
  }

  /**
   * Empties every table.
   *
   * Truncating rather than re-migrating: the migration takes ~1.5s and the truncate ~10ms,
   * and the schema cannot change mid-file. `__drizzle_migrations` lives in the `drizzle`
   * schema and is deliberately untouched.
   */
  private async reset(): Promise<void> {
    if (this.client && this.truncateStatement) {
      await this.client.exec(this.truncateStatement)
    }
    resetSequences()
  }

  private async stop(): Promise<void> {
    setDatabase(null)
    await this.client?.close()
    this.client = undefined
    this.database = undefined
  }
}
