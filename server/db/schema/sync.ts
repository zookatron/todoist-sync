import { sql } from 'drizzle-orm'
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.js'

export const mappingKindEnum = pgEnum('mapping_kind', ['role', 'project'])

/**
 * Glassfrog role/project ↔ Todoist project. Exactly one Todoist project per Glassfrog node
 * and vice versa, whichever side it originated on.
 *
 * A row **outlives completion**: when a project is finished, the Glassfrog node goes to
 * `completed` and the Todoist project is archived, but the row stays as a tombstone. That is
 * what lets a later unarchive reopen the Glassfrog project instead of creating a second one.
 * Rows are only dropped once the node is gone from both sides.
 */
export const projectMapping = pgTable(
  'project_mapping',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: mappingKindEnum('kind').notNull(),
    /** Glassfrog api_id of the role or project. */
    glassfrogId: text('glassfrog_id').notNull(),
    todoistProjectId: text('todoist_project_id').notNull(),
    /** Glassfrog id of the parent node; null when the parent is the configured root. */
    parentGlassfrogId: text('parent_glassfrog_id'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('project_mapping_glassfrog_idx').on(table.userId, table.kind, table.glassfrogId),
    uniqueIndex('project_mapping_todoist_idx').on(table.userId, table.todoistProjectId),
  ],
)

/**
 * Glassfrog Action ↔ Todoist Task.
 *
 * Both id columns are nullable: a row can exist for something that lives on one side
 * only and is pending creation on the other.
 *
 * `contentHash` is what stops sync ping-pong. Writing to either API bumps that record's
 * `updated_at`, so the next poll sees our own write as a change; if the incoming data
 * hashes to the stored value, it is our echo and is dropped.
 */
export const taskMapping = pgTable(
  'task_mapping',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    glassfrogActionId: text('glassfrog_action_id'),
    todoistTaskId: text('todoist_task_id'),
    /** Last `updated_at` observed on each side, INCLUDING our own writes. */
    glassfrogUpdatedAt: timestamp('glassfrog_updated_at', { withTimezone: true }),
    todoistUpdatedAt: timestamp('todoist_updated_at', { withTimezone: true }),
    /** Hash of the normalized synced field set. See note above. */
    contentHash: text('content_hash'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('task_mapping_glassfrog_idx')
      .on(table.userId, table.glassfrogActionId)
      .where(sql`${table.glassfrogActionId} is not null`),
    uniqueIndex('task_mapping_todoist_idx')
      .on(table.userId, table.todoistTaskId)
      .where(sql`${table.todoistTaskId} is not null`),
  ],
)

/**
 * Activity feed shown on the dashboard. `description` is the human-readable line shown to
 * the user; `metadata` is free-form JSON for developers debugging a specific entry.
 */
export const syncLog = pgTable(
  'sync_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sync_log_user_created_idx').on(table.userId, table.createdAt.desc())],
)
