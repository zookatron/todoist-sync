import { sql } from 'drizzle-orm'
import {
  boolean,
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

export const pruneModeEnum = pgEnum('prune_mode', ['dry-run', 'archive'])
export const mappingKindEnum = pgEnum('mapping_kind', ['role', 'project'])
export const syncLogLevelEnum = pgEnum('sync_log_level', ['info', 'warn', 'error'])

/** Per-user sync settings and cursors. */
export const syncConfig = pgTable('sync_config', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** The Todoist project the mirrored hierarchy lives under. Null until chosen. */
  rootTodoistProjectId: text('root_todoist_project_id'),
  enabled: boolean('enabled').notNull().default(false),
  /**
   * Cursor for Todoist's incremental sync. Null means "next poll does a full sync".
   * Persisted only after the resulting jobs are enqueued, so a crash re-delivers
   * changes rather than skipping them.
   */
  todoistSyncToken: text('todoist_sync_token'),
  /** Overrides the PRUNE_MODE environment default when set. */
  pruneMode: pruneModeEnum('prune_mode'),
  lastPollAt: timestamp('last_poll_at', { withTimezone: true }),
  lastHierarchySyncAt: timestamp('last_hierarchy_sync_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Glassfrog role/project → Todoist project. One-way mirror, so there is exactly one
 * Todoist project per Glassfrog node and vice versa.
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
    name: text('name').notNull(),
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
    /** Tombstone: set when the pair was deleted on either side. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
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

/** Activity feed shown on the dashboard, and the audit trail for destructive operations. */
export const syncLog = pgTable(
  'sync_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    level: syncLogLevelEnum('level').notNull().default('info'),
    /** e.g. 'task', 'project', 'hierarchy', 'auth' */
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    /** e.g. 'create', 'update', 'delete', 'archive', 'skip' */
    action: text('action').notNull(),
    message: text('message').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sync_log_user_created_idx').on(table.userId, table.createdAt.desc())],
)
