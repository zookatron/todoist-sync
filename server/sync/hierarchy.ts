import { and, eq } from 'drizzle-orm'
import { type Database, db as defaultDb } from '../db/index.js'
import { todoistIntegration } from '../db/schema/integrations.js'
import { projectMapping, syncLog } from '../db/schema/sync.js'
import { getGlassfrogClient } from '../glassfrog/client.js'
import type { Client } from '../glassfrog/generated/client/index.js'
import {
  createProject as createGlassfrogProject,
  GLASSFROG_PROJECT_COMPLETED,
  GLASSFROG_PROJECT_CURRENT,
  renameProject as renameGlassfrogProject,
  setProjectStatus,
} from '../glassfrog/projects.js'
import {
  addProject,
  archiveProject,
  moveProject,
  renameProject as renameTodoistProject,
  unarchiveProject,
} from '../todoist/projects.js'
import { logger } from '../utils/logger.js'
import { type ActualProject, readActualTree } from './actual-tree.js'
import { buildDesiredTree } from './desired-tree.js'
import { diffHierarchy, type HierarchyOperation, type MappingKind } from './hierarchy-diff.js'

/** One counter per operation, so the shape cannot drift from the operation union. */
export type HierarchyResult = Record<HierarchyOperation['type'] | 'failed', number>

export function emptyHierarchyResult(): HierarchyResult {
  return {
    'create-glassfrog': 0,
    'create-todoist': 0,
    'rename-todoist': 0,
    'rename-glassfrog': 0,
    'move-todoist': 0,
    'complete-glassfrog': 0,
    'reopen-glassfrog': 0,
    'archive-todoist': 0,
    'unarchive-todoist': 0,
    'drop-mapping': 0,
    failed: 0,
  }
}

type MappingRow = {
  kind: MappingKind
  glassfrogId: string
  todoistProjectId: string
  parentGlassfrogId: string | null
}

/**
 * What a Todoist project corresponds to on the Glassfrog side.
 *
 * `roleGlassfrogId` is carried because creating a Glassfrog project needs an owning role —
 * `POST /roles/{role_id}/projects` is the only creation endpoint — and for a nested project
 * that role is several links up the chain.
 */
type Counterpart = {
  kind: MappingKind
  glassfrogId: string
  roleGlassfrogId: string | null
}

/**
 * Reconciles the Glassfrog and Todoist project trees.
 *
 * Two-way, but not symmetrically so: roles are Glassfrog's alone, while projects can be
 * created, completed, reopened and renamed from either side. See `hierarchy-diff.ts` for
 * the full table.
 *
 * Runs before task sync in every poll, so per-task jobs always find their destination
 * project.
 */
export async function syncHierarchy(
  userId: string,
  options: { db?: Database } = {},
): Promise<HierarchyResult> {
  const db = options.db ?? defaultDb
  const log = logger.child({ userId, job: 'hierarchy' })

  const integration = await db.query.todoistIntegration.findFirst({
    where: eq(todoistIntegration.userId, userId),
  })
  const rootId = integration?.rootTodoistProjectId

  if (!rootId) {
    log.debug('No root Todoist project configured; skipping hierarchy sync')
    return emptyHierarchyResult()
  }

  const glassfrog = await getGlassfrogClient(userId)

  const [desired, actual, mappings] = await Promise.all([
    buildDesiredTree(glassfrog),
    readActualTree(userId, rootId),
    db.select().from(projectMapping).where(eq(projectMapping.userId, userId)),
  ])

  const operations = diffHierarchy({
    desired,
    actual,
    mappings: mappings.map((m) => ({
      kind: m.kind,
      glassfrogId: m.glassfrogId,
      todoistProjectId: m.todoistProjectId,
    })),
    rootTodoistProjectId: rootId,
  })

  logUnclaimedRootProjects({ userId, actual, mappings, rootId })

  if (operations.length === 0) return emptyHierarchyResult()

  log.info({ operations: operations.length }, 'Applying hierarchy changes')

  return applyOperations({ userId, db, glassfrog, rootId, operations, mappings })
}

/**
 * Notes the projects sitting directly under the root that the mirror deliberately ignores.
 *
 * Only a role can live there and roles come from Glassfrog, so a project the user put there
 * by hand is neither adopted nor archived — it is simply left alone. That silence is easy to
 * mistake for a bug, hence the line.
 *
 * Deliberately the logger rather than `sync_log`: this condition persists for as long as the
 * project does, so writing it to the activity feed would repeat it on every poll forever.
 */
function logUnclaimedRootProjects(args: {
  userId: string
  actual: ActualProject[]
  mappings: MappingRow[]
  rootId: string
}): void {
  const mapped = new Set(args.mappings.map((m) => m.todoistProjectId))

  const ignored = args.actual.filter(
    (project) =>
      project.parentId === args.rootId &&
      !project.archived &&
      !mapped.has(project.todoistProjectId),
  )

  if (ignored.length === 0) return

  logger
    .child({ userId: args.userId, job: 'hierarchy' })
    .debug(
      { projects: ignored.map((project) => project.name) },
      'Ignoring Todoist projects directly under the root; roles are only created in Glassfrog',
    )
}

/**
 * Resolves each mapped Todoist project to its Glassfrog counterpart, owning role included.
 *
 * The role is found by walking `parentGlassfrogId` upward until a role mapping turns up,
 * which is also why that column has to stay current on every mapping write.
 */
function buildCounterparts(mappings: MappingRow[]): Map<string, Counterpart> {
  const byGlassfrogId = new Map(mappings.map((m) => [m.glassfrogId, m]))

  const roleOf = (mapping: MappingRow): string | null => {
    let current = mapping
    const seen = new Set<string>([current.glassfrogId])

    while (current.kind !== 'role') {
      if (!current.parentGlassfrogId) return null

      const parent = byGlassfrogId.get(current.parentGlassfrogId)
      if (!parent || seen.has(parent.glassfrogId)) return null

      seen.add(parent.glassfrogId)
      current = parent
    }

    return current.glassfrogId
  }

  return new Map(
    mappings.map((mapping) => [
      mapping.todoistProjectId,
      {
        kind: mapping.kind,
        glassfrogId: mapping.glassfrogId,
        roleGlassfrogId: mapping.kind === 'role' ? mapping.glassfrogId : roleOf(mapping),
      },
    ]),
  )
}

async function applyOperations(args: {
  userId: string
  db: Database
  glassfrog: Client
  rootId: string
  operations: HierarchyOperation[]
  mappings: MappingRow[]
}): Promise<HierarchyResult> {
  const { userId, db, glassfrog, rootId, operations } = args
  const log = logger.child({ userId, job: 'hierarchy' })

  const result = emptyHierarchyResult()

  // Glassfrog id → Todoist project id, kept current as projects are created so that a
  // child created later in the same pass can resolve its brand-new parent.
  const todoistIdByGlassfrogId = new Map(
    args.mappings.map((m) => [m.glassfrogId, m.todoistProjectId]),
  )

  // The same relationship from the other end, for the adoption path: a project adopted
  // earlier in this pass is the parent an adoption later in it needs.
  const counterparts = buildCounterparts(args.mappings)

  const resolveParent = (parentGlassfrogId: string | null): string =>
    parentGlassfrogId ? (todoistIdByGlassfrogId.get(parentGlassfrogId) ?? rootId) : rootId

  const logEntries: (typeof syncLog.$inferInsert)[] = []

  for (const operation of operations) {
    try {
      switch (operation.type) {
        case 'create-todoist': {
          const { node } = operation
          const created = await addProject(userId, {
            name: node.name,
            parentId: resolveParent(node.parentGlassfrogId),
          })

          todoistIdByGlassfrogId.set(node.glassfrogId, created.id)
          counterparts.set(created.id, {
            kind: node.kind,
            glassfrogId: node.glassfrogId,
            roleGlassfrogId:
              node.kind === 'role'
                ? node.glassfrogId
                : (counterparts.get(resolveParent(node.parentGlassfrogId))?.roleGlassfrogId ??
                  null),
          })

          await db
            .insert(projectMapping)
            .values({
              userId,
              kind: node.kind,
              glassfrogId: node.glassfrogId,
              todoistProjectId: created.id,
              parentGlassfrogId: node.parentGlassfrogId,
            })
            .onConflictDoUpdate({
              target: [projectMapping.userId, projectMapping.kind, projectMapping.glassfrogId],
              set: {
                todoistProjectId: created.id,
                parentGlassfrogId: node.parentGlassfrogId,
                lastSyncedAt: new Date(),
              },
            })

          logEntries.push({
            userId,
            description: `Created Todoist project "${node.name}"`,
            metadata: { entity: 'project', action: 'create', glassfrogId: node.glassfrogId },
          })
          break
        }

        case 'create-glassfrog': {
          const parent = counterparts.get(operation.parentTodoistProjectId)
          const roleGlassfrogId =
            parent?.kind === 'role' ? parent.glassfrogId : (parent?.roleGlassfrogId ?? null)

          if (!parent || !roleGlassfrogId) {
            // Only reachable if the parent's own adoption failed earlier in this pass.
            log.warn(
              { todoistProjectId: operation.todoistProjectId },
              'No owning Glassfrog role for this Todoist project; skipping until next poll',
            )
            result.failed += 1
            continue
          }

          const parentProjectGlassfrogId = parent.kind === 'role' ? null : parent.glassfrogId

          const created = await createGlassfrogProject(glassfrog, {
            roleId: roleGlassfrogId,
            parentProjectId: parentProjectGlassfrogId,
            name: operation.name,
          })

          todoistIdByGlassfrogId.set(created.id, operation.todoistProjectId)
          counterparts.set(operation.todoistProjectId, {
            kind: 'project',
            glassfrogId: created.id,
            roleGlassfrogId,
          })

          await db.insert(projectMapping).values({
            userId,
            kind: 'project',
            glassfrogId: created.id,
            todoistProjectId: operation.todoistProjectId,
            parentGlassfrogId: parentProjectGlassfrogId ?? roleGlassfrogId,
          })

          logEntries.push({
            userId,
            description: `Created Glassfrog project "${operation.name}"`,
            metadata: {
              entity: 'project',
              action: 'create',
              glassfrogId: created.id,
              todoistProjectId: operation.todoistProjectId,
            },
          })
          break
        }

        case 'rename-todoist': {
          await renameTodoistProject(userId, operation.todoistProjectId, operation.to)
          await touchMapping(db, userId, operation.todoistProjectId)

          logEntries.push({
            userId,
            description: `Renamed Todoist project "${operation.from}" to "${operation.to}"`,
            metadata: { entity: 'project', action: 'rename', glassfrogId: operation.glassfrogId },
          })
          break
        }

        case 'rename-glassfrog': {
          await renameGlassfrogProject(glassfrog, operation.glassfrogId, operation.to)
          await touchMapping(db, userId, operation.todoistProjectId)

          logEntries.push({
            userId,
            description: `Renamed Glassfrog project "${operation.from}" to "${operation.to}"`,
            metadata: { entity: 'project', action: 'rename', glassfrogId: operation.glassfrogId },
          })
          break
        }

        case 'move-todoist': {
          const parentId = resolveParent(operation.toParentGlassfrogId)
          await moveProject(userId, operation.todoistProjectId, parentId)

          // Keep the stored chain current: `buildCounterparts` above and
          // `resolveOwningRole` in the task job both walk it.
          await db
            .update(projectMapping)
            .set({ parentGlassfrogId: operation.toParentGlassfrogId, lastSyncedAt: new Date() })
            .where(
              and(
                eq(projectMapping.userId, userId),
                eq(projectMapping.todoistProjectId, operation.todoistProjectId),
              ),
            )

          logEntries.push({
            userId,
            description: `Moved "${operation.name}" into its mapped parent`,
            metadata: { entity: 'project', action: 'move', glassfrogId: operation.glassfrogId },
          })
          break
        }

        case 'complete-glassfrog': {
          await setProjectStatus(glassfrog, operation.glassfrogId, GLASSFROG_PROJECT_COMPLETED)
          await touchMapping(db, userId, operation.todoistProjectId)

          logEntries.push({
            userId,
            description:
              `Completed Glassfrog project "${operation.name}" — archived in Todoist. ` +
              'Any open actions on it still need finishing in Glassfrog.',
            metadata: { entity: 'project', action: 'complete', glassfrogId: operation.glassfrogId },
          })
          break
        }

        case 'reopen-glassfrog': {
          await setProjectStatus(glassfrog, operation.glassfrogId, GLASSFROG_PROJECT_CURRENT)
          await touchMapping(db, userId, operation.todoistProjectId)

          logEntries.push({
            userId,
            description: `Reopened Glassfrog project "${operation.name}" — unarchived in Todoist`,
            metadata: { entity: 'project', action: 'reopen', glassfrogId: operation.glassfrogId },
          })
          break
        }

        case 'archive-todoist': {
          // Archive rather than delete: recoverable in Todoist if the mirror is wrong.
          await archiveProject(userId, operation.todoistProjectId)

          logEntries.push({
            userId,
            description: `Archived "${operation.name}" — no matching Glassfrog role or project`,
            metadata: {
              entity: 'project',
              action: 'archive',
              todoistProjectId: operation.todoistProjectId,
            },
          })
          break
        }

        case 'unarchive-todoist': {
          await unarchiveProject(userId, operation.todoistProjectId)
          await touchMapping(db, userId, operation.todoistProjectId)

          logEntries.push({
            userId,
            description: `Unarchived "${operation.name}" — roles are managed in Glassfrog`,
            metadata: {
              entity: 'project',
              action: 'unarchive',
              todoistProjectId: operation.todoistProjectId,
            },
          })
          break
        }

        case 'drop-mapping': {
          // Housekeeping; deliberately not written to the activity feed.
          await db
            .delete(projectMapping)
            .where(
              and(
                eq(projectMapping.userId, userId),
                eq(projectMapping.todoistProjectId, operation.todoistProjectId),
              ),
            )
          break
        }
      }

      result[operation.type] += 1
    } catch (error) {
      // One bad operation must not abort the whole reconciliation.
      log.error({ err: error, operation: operation.type }, 'Hierarchy operation failed')
      result.failed += 1
      logEntries.push({
        userId,
        description: `Operation failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { entity: 'project', action: operation.type },
      })
    }
  }

  if (logEntries.length > 0) await db.insert(syncLog).values(logEntries)

  log.info(result, 'Hierarchy sync complete')
  return result
}

async function touchMapping(db: Database, userId: string, todoistProjectId: string): Promise<void> {
  await db
    .update(projectMapping)
    .set({ lastSyncedAt: new Date() })
    .where(
      and(eq(projectMapping.userId, userId), eq(projectMapping.todoistProjectId, todoistProjectId)),
    )
}
