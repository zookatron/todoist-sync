import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth.js'

/**
 * Todoist personal API token and sync state. Static — no expiry, scopes, or refresh.
 */
export const todoistIntegration = pgTable('todoist_integration', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  apiKey: text('api_key').notNull(),
  /** The Todoist project the mirrored hierarchy lives under. Null until chosen. */
  rootTodoistProjectId: text('root_todoist_project_id'),
  /**
   * Cursor for Todoist's incremental sync. Null means "next poll does a full sync".
   * Persisted only after the resulting jobs are enqueued, so a crash re-delivers
   * changes rather than skipping them.
   */
  todoistSyncToken: text('todoist_sync_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Glassfrog API v5 key. Static — it does not expire, carry scopes, or support refresh.
 */
export const glassfrogIntegration = pgTable('glassfrog_integration', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  apiKey: text('api_key').notNull(),
  /**
   * The key owner's v5 actor id (`per_…`), read from `/me` when the key is saved. Ownership is
   * `actor_id` equal to this. Nullable only for rows saved before it existed; the first poll
   * fills it in.
   */
  actorId: text('actor_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
