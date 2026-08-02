import type { TodoistApi } from '@doist/todoist-sdk'
import { and, eq, inArray } from 'drizzle-orm'
import { type Database, db as defaultDb } from '../db/index.js'
import { projectMapping, syncConfig, syncLog } from '../db/schema/sync.js'
import { env } from '../env.js'
import { getGlassfrogClient } from '../glassfrog/client.js'
import { logger } from '../logger.js'
import { callTodoist, moveTodoistProject } from '../todoist/client.js'
import { buildDesiredTree } from './desired-tree.js'
import {
  type ActualProject,
  type DesiredNode,
  diffHierarchy,
  type HierarchyOperation,
} from './hierarchy-diff.js'

export type PruneMode = 'dry-run' | 'archive'

export type HierarchyResult = {
  created: number
  renamed: number
  moved: number
  archived: number
  skipped: number
}

/**
 * Lists every Todoist project that sits beneath `rootId`, at any depth.
 *
 * Todoist only exposes a parent pointer, so descendants are resolved by repeatedly
 * expanding the frontier rather than by a single query.
 */
export function descendantsOf(
  rootId: string,
  projects: { id: string; name: string; parentId: string | null }[],
): ActualProject[] {
  const childrenByParent = new Map<string, typeof projects>()
  for (const project of projects) {
    if (!project.parentId) continue
    const siblings = childrenByParent.get(project.parentId) ?? []
    siblings.push(project)
    childrenByParent.set(project.parentId, siblings)
  }

  const collected: ActualProject[] = []
  const queue = [rootId]
  const seen = new Set<string>([rootId])

  while (queue.length > 0) {
    const parentId = queue.shift()
    if (!parentId) break

    for (const child of childrenByParent.get(parentId) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      collected.push({
        todoistProjectId: child.id,
        name: child.name,
        parentId: child.parentId,
      })
      queue.push(child.id)
    }
  }

  return collected
}

async function listTodoistProjects(userId: string) {
  return callTodoist(userId, async (api) => {
    const collected: { id: string; name: string; parentId: string | null }[] = []
    let cursor: string | null = null

    do {
      const page = await api.getProjects(cursor ? { cursor } : {})
      collected.push(
        ...page.results.map((project) => ({
          id: project.id,
          name: project.name,
          parentId: 'parentId' in project ? (project.parentId ?? null) : null,
        })),
      )
      cursor = page.nextCursor ?? null
    } while (cursor)

    return collected
  })
}

/**
 * Reconciles the Todoist project tree with Glassfrog. One-way: Glassfrog wins.
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

  const config = await db.query.syncConfig.findFirst({ where: eq(syncConfig.userId, userId) })
  const rootId = config?.rootTodoistProjectId

  if (!rootId) {
    log.debug('No root Todoist project configured; skipping hierarchy sync')
    return { created: 0, renamed: 0, moved: 0, archived: 0, skipped: 0 }
  }

  const glassfrog = await getGlassfrogClient(userId)

  const [desired, allProjects, mappings] = await Promise.all([
    buildDesiredTree(glassfrog),
    listTodoistProjects(userId),
    db.select().from(projectMapping).where(eq(projectMapping.userId, userId)),
  ])

  const actual = descendantsOf(rootId, allProjects)

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

  if (operations.length === 0) {
    await db
      .update(syncConfig)
      .set({ lastHierarchySyncAt: new Date() })
      .where(eq(syncConfig.userId, userId))
    return { created: 0, renamed: 0, moved: 0, archived: 0, skipped: 0 }
  }

  log.info({ operations: operations.length }, 'Applying hierarchy changes')

  return applyOperations({
    userId,
    db,
    rootId,
    operations,
    mappings,
    pruneMode: resolvePruneMode(config?.pruneMode),
  })
}

function resolvePruneMode(configured: PruneMode | null | undefined): PruneMode {
  return configured ?? env.PRUNE_MODE
}

async function applyOperations(args: {
  userId: string
  db: Database
  rootId: string
  operations: HierarchyOperation[]
  mappings: { kind: 'role' | 'project'; glassfrogId: string; todoistProjectId: string }[]
  pruneMode: PruneMode
}): Promise<HierarchyResult> {
  const { userId, db, rootId, operations, pruneMode } = args
  const log = logger.child({ userId, job: 'hierarchy' })

  const result: HierarchyResult = { created: 0, renamed: 0, moved: 0, archived: 0, skipped: 0 }

  // Glassfrog id → Todoist project id, kept current as projects are created so that a
  // child created later in the same pass can resolve its brand-new parent.
  const todoistIdByGlassfrogId = new Map(
    args.mappings.map((m) => [m.glassfrogId, m.todoistProjectId]),
  )

  const resolveParent = (parentGlassfrogId: string | null): string =>
    parentGlassfrogId ? (todoistIdByGlassfrogId.get(parentGlassfrogId) ?? rootId) : rootId

  const logEntries: (typeof syncLog.$inferInsert)[] = []

  for (const operation of operations) {
    try {
      switch (operation.type) {
        case 'create': {
          const projectId = await createProject(userId, operation.node, resolveParent)
          todoistIdByGlassfrogId.set(operation.node.glassfrogId, projectId)

          await db
            .insert(projectMapping)
            .values({
              userId,
              kind: operation.node.kind,
              glassfrogId: operation.node.glassfrogId,
              todoistProjectId: projectId,
              parentGlassfrogId: operation.node.parentGlassfrogId,
              name: operation.node.name,
            })
            .onConflictDoUpdate({
              target: [projectMapping.userId, projectMapping.kind, projectMapping.glassfrogId],
              set: {
                todoistProjectId: projectId,
                name: operation.node.name,
                lastSyncedAt: new Date(),
              },
            })

          result.created += 1
          logEntries.push({
            userId,
            entity: 'project',
            entityId: operation.node.glassfrogId,
            action: 'create',
            message: `Created Todoist project "${operation.node.name}"`,
          })
          break
        }

        case 'rename': {
          await callTodoist(userId, (api) =>
            api.updateProject(operation.todoistProjectId, { name: operation.to }),
          )

          await db
            .update(projectMapping)
            .set({ name: operation.to, lastSyncedAt: new Date() })
            .where(
              and(
                eq(projectMapping.userId, userId),
                eq(projectMapping.todoistProjectId, operation.todoistProjectId),
              ),
            )

          result.renamed += 1
          logEntries.push({
            userId,
            entity: 'project',
            entityId: operation.glassfrogId,
            action: 'rename',
            message: `Renamed "${operation.from}" to "${operation.to}"`,
          })
          break
        }

        case 'move': {
          const parentId = resolveParent(operation.toParentGlassfrogId)
          await moveTodoistProject(userId, operation.todoistProjectId, parentId)

          result.moved += 1
          logEntries.push({
            userId,
            entity: 'project',
            entityId: operation.glassfrogId,
            action: 'move',
            message: `Moved project under ${parentId}`,
          })
          break
        }

        case 'orphan': {
          if (pruneMode === 'dry-run') {
            result.skipped += 1
            logEntries.push({
              userId,
              level: 'warn',
              entity: 'project',
              entityId: operation.todoistProjectId,
              action: 'skip',
              message: `Would archive "${operation.name}" (PRUNE_MODE=dry-run)`,
            })
            break
          }

          // Archive rather than delete: recoverable in Todoist if the mirror is wrong.
          await callTodoist(userId, (api) => api.archiveProject(operation.todoistProjectId))

          await db
            .delete(projectMapping)
            .where(
              and(
                eq(projectMapping.userId, userId),
                eq(projectMapping.todoistProjectId, operation.todoistProjectId),
              ),
            )

          result.archived += 1
          logEntries.push({
            userId,
            level: 'warn',
            entity: 'project',
            entityId: operation.todoistProjectId,
            action: 'archive',
            message: `Archived "${operation.name}" — no matching Glassfrog role or project`,
          })
          break
        }
      }
    } catch (error) {
      // One bad operation must not abort the whole reconciliation.
      log.error({ err: error, operation: operation.type }, 'Hierarchy operation failed')
      logEntries.push({
        userId,
        level: 'error',
        entity: 'project',
        action: operation.type,
        message: `Operation failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  if (logEntries.length > 0) await db.insert(syncLog).values(logEntries)

  await db
    .update(syncConfig)
    .set({ lastHierarchySyncAt: new Date() })
    .where(eq(syncConfig.userId, userId))

  // Drop mapping rows whose Todoist project no longer exists.
  await pruneStaleMappings(userId, db)

  log.info(result, 'Hierarchy sync complete')
  return result
}

async function createProject(
  userId: string,
  node: DesiredNode,
  resolveParent: (parentGlassfrogId: string | null) => string,
): Promise<string> {
  const parentId = resolveParent(node.parentGlassfrogId)

  const project = await callTodoist(userId, (api: TodoistApi) =>
    api.addProject({ name: node.name, parentId }),
  )

  return project.id
}

/** Removes mapping rows pointing at Todoist projects that have since disappeared. */
async function pruneStaleMappings(userId: string, db: Database): Promise<void> {
  const mappings = await db.select().from(projectMapping).where(eq(projectMapping.userId, userId))

  if (mappings.length === 0) return

  const live = new Set((await listTodoistProjects(userId)).map((project) => project.id))
  const stale = mappings.filter((m) => !live.has(m.todoistProjectId)).map((m) => m.id)

  if (stale.length > 0) {
    await db.delete(projectMapping).where(inArray(projectMapping.id, stale))
  }
}
