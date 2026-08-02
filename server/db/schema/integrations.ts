import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth.js'

/**
 * Todoist OAuth credentials and sync state.
 *
 * Access tokens issued to new Todoist apps expire after one hour, and the refresh token
 * ROTATES on every refresh (the previous one dies after ~60s). Always read these through
 * `getValidAccessToken()` in server/todoist/tokens.ts, never directly.
 */
export const todoistIntegration = pgTable('todoist_integration', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(),
  /** Absent only for legacy Todoist apps that issue long-lived tokens. */
  refreshToken: text('refresh_token'),
  /** Null means the token does not expire (legacy long-lived token). */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /**
   * Set when a refresh fails irrecoverably. The dashboard surfaces this and the user
   * must reconnect; sync jobs skip the account rather than hammering a dead token.
   */
  needsReauth: timestamp('needs_reauth_at', { withTimezone: true }),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
