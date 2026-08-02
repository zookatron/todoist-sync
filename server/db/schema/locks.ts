import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Backing table for the generic lock utility (server/lock.ts).
 *
 * Locks are acquired with a single atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE
 * expires_at < now()`, so no transaction or advisory lock is needed.
 *
 * Every lock carries an owner and a TTL: only the owner may release one, and an expired
 * lock can be stolen, so a crashed worker cannot deadlock the system.
 */
export const locks = pgTable('locks', {
  /** Namespaced, e.g. `task:{userId}:{actionId}` or `poll:{userId}`. */
  key: text('key').primaryKey(),
  /** Identifies the holder — normally the BullMQ job id. */
  owner: text('owner').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
