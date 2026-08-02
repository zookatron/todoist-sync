import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { env } from '../env.js'
import * as schema from './schema/index.js'

/**
 * Shared connection pool. Both the web server and the worker create one of these in
 * their own process; `max` is deliberately small since this is a single-user app.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
})

export const db = drizzle(pool, { schema })

export type Database = typeof db

export { schema }
