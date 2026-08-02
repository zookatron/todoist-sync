import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { encryptedText } from '../../crypto.js'
import { user } from './auth.js'

/**
 * Todoist OAuth credentials.
 *
 * Access tokens issued to new Todoist apps expire after one hour, and the refresh token
 * ROTATES on every refresh (the previous one dies after ~60s). Always read these through
 * `getValidAccessToken()` in server/todoist/tokens.ts, never directly.
 */
export const todoistIntegration = pgTable('todoist_integration', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: encryptedText('access_token').notNull(),
  /** Absent only for legacy Todoist apps that issue long-lived tokens. */
  refreshToken: encryptedText('refresh_token'),
  /** Null means the token does not expire (legacy long-lived token). */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  scope: text('scope'),
  todoistUserId: text('todoist_user_id'),
  todoistEmail: text('todoist_email'),
  /**
   * Set when a refresh fails irrecoverably. The dashboard surfaces this and the user
   * must reconnect; sync jobs skip the account rather than hammering a dead token.
   */
  needsReauth: timestamp('needs_reauth_at', { withTimezone: true }),
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
  apiKey: encryptedText('api_key').notNull(),
  /** Populated from GET /me when the key is saved, so the UI can confirm the identity. */
  personId: text('person_id'),
  personName: text('person_name'),
  orgName: text('org_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
