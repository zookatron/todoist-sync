import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { env } from '../utils/env.js'
import * as schema from './schema/index.js'

/**
 * Shared connection pool. Both the web server and the worker create one of these in
 * their own process; `max` is deliberately small since this is a single-user app.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
})

/**
 * Any Drizzle Postgres database, rather than the node-postgres one specifically.
 *
 * Widened so tests can substitute a PGlite-backed instance (see
 * `server/testing/database.ts`). Every driver's database class extends this, so nothing
 * in the app has to care which one it holds.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>

const realDb: Database = drizzle(pool, { schema })

/**
 * The database every module talks to.
 *
 * A mutable binding rather than a const so tests can point the whole application at an
 * in-memory instance without mocking modules — ESM live bindings mean existing
 * `import { db }` call sites pick the substitute up with no change. Always `realDb` in
 * production; only {@link setDatabase} moves it.
 */
export let db: Database = realDb

/** Test seam. Pass null to restore the real pool. */
export function setDatabase(next: Database | null): void {
  db = next ?? realDb
}

export { schema }
