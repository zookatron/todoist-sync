import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { projectMapping, syncLog, taskMapping } from '../../db/schema/sync.js'
import { getGlassfrogClient } from '../../glassfrog/client.js'
import type { Client } from '../../glassfrog/generated/client/index.js'
import {
  completeAction,
  createAction,
  deleteAction,
  getAction,
  uncompleteAction,
  updateAction,
} from '../../glassfrog/generated/sdk.gen.js'
import type { Action } from '../../glassfrog/generated/types.gen.js'
import {
  contentHash,
  GLASSFROG_COMPLETED_STATUS,
  GLASSFROG_DEAD_STATUSES,
  resolve,
  type SideState,
  type TaskSnapshot,
} from '../../sync/resolve.js'
import { callTodoist } from '../../todoist/client.js'
import { withLock } from '../../utils/lock.js'
import { logger } from '../../utils/logger.js'
import type { TaskJobData } from '../queues.js'

const LOCK_TTL_MS = 60_000

/**
 * Syncs one task.
 *
 * Runs under `task:{userId}:{key}`. Unlike the poll job, contention here is an error:
 * two jobs writing the same task concurrently could interleave reads and writes and lose
 * an update, so the second job **fails** and BullMQ retries it with backoff.
 */
export async function runTaskSync(data: TaskJobData, owner: string): Promise<void> {
  const key = data.glassfrogActionId ?? `td:${data.todoistTaskId}`

  await withLock(`task:${data.userId}:${key}`, { owner, ttlMs: LOCK_TTL_MS }, () => syncOne(data))
}

function toGlassfrogSnapshot(action: Action): TaskSnapshot {
  return {
    content: action.description ?? '',
    description: action.note ?? '',
    completed: action.status === GLASSFROG_COMPLETED_STATUS,
    updatedAt: action.updated_at ? new Date(action.updated_at) : null,
  }
}

async function syncOne(data: TaskJobData): Promise<void> {
  const { userId } = data
  const log = logger.child({ userId, job: 'sync-task' })

  const mapping = await findMapping(data)
  const glassfrogActionId = data.glassfrogActionId ?? mapping?.glassfrogActionId ?? null
  const todoistTaskId = data.todoistTaskId ?? mapping?.todoistTaskId ?? null

  const client = await getGlassfrogClient(userId)

  const glassfrog = await readGlassfrogSide(client, glassfrogActionId)
  const todoist = await readTodoistSide(userId, todoistTaskId)

  const decision = resolve({
    glassfrog: glassfrog.state,
    todoist: todoist.state,
    mapping: { linked: Boolean(mapping), contentHash: mapping?.contentHash ?? null },
  })

  log.debug({ decision: decision.type, glassfrogActionId, todoistTaskId }, 'Resolved task sync')

  switch (decision.type) {
    case 'noop':
      if (mapping) {
        await db
          .update(taskMapping)
          .set({ lastSyncedAt: new Date() })
          .where(eq(taskMapping.id, mapping.id))
      }
      return

    case 'create-todoist': {
      if (!glassfrog.action) return

      // Actions that are cancelled or archived should not appear in Todoist at all.
      if (GLASSFROG_DEAD_STATUSES.has(glassfrog.action.status)) return

      const projectId = await resolveDestinationProject(userId, glassfrog.action)
      if (!projectId) {
        log.warn(
          { glassfrogActionId },
          'No mapped Todoist project for this action; skipping until the hierarchy catches up',
        )
        return
      }

      const snapshot = toGlassfrogSnapshot(glassfrog.action)
      const created = await callTodoist(userId, (api) =>
        api.addTask({
          content: snapshot.content || 'Untitled action',
          description: snapshot.description,
          projectId,
        }),
      )

      if (snapshot.completed) {
        await callTodoist(userId, (api) => api.closeTask(created.id))
      }

      await upsertMapping({
        userId,
        mappingId: mapping?.id,
        glassfrogActionId: glassfrog.action.id,
        todoistTaskId: created.id,
        // Re-read our own write's timestamps so the next poll does not see an echo.
        glassfrogUpdatedAt: snapshot.updatedAt,
        todoistUpdatedAt: created.updatedAt ?? new Date(),
        hash: contentHash(snapshot),
      })

      await record(userId, 'Created Todoist task', {
        entity: 'task',
        action: 'create',
        glassfrogActionId: glassfrog.action.id,
      })
      return
    }

    case 'create-glassfrog': {
      if (!todoist.task || !todoistTaskId) return

      const roleId = await resolveOwningRole(userId, todoist.task.projectId)
      if (!roleId) {
        log.warn({ todoistTaskId }, 'Todoist task is not inside a mapped role project; skipping')
        return
      }

      const snapshot = todoist.state.present ? todoist.state.snapshot : null
      if (!snapshot) return

      const response = await createAction({
        client,
        path: { role_id: roleId.roleGlassfrogId },
        body: {
          action_item: {
            description: snapshot.content,
            note: snapshot.description || undefined,
            status: snapshot.completed ? 'completed' : 'current',
            parent_project_id: roleId.projectGlassfrogId,
          },
        },
        throwOnError: true,
      })

      const action = response.data.data

      await upsertMapping({
        userId,
        mappingId: mapping?.id,
        glassfrogActionId: action.id,
        todoistTaskId,
        glassfrogUpdatedAt: action.updated_at ? new Date(action.updated_at) : new Date(),
        todoistUpdatedAt: snapshot.updatedAt,
        hash: contentHash(snapshot),
      })

      await record(userId, 'Created Glassfrog action', {
        entity: 'task',
        action: 'create',
        glassfrogActionId: action.id,
      })
      return
    }

    case 'update-todoist': {
      if (!todoistTaskId || !glassfrog.action) return

      await callTodoist(userId, (api) =>
        api.updateTask(todoistTaskId, {
          content: decision.snapshot.content || 'Untitled action',
          description: decision.snapshot.description,
        }),
      )

      if (decision.snapshot.completed !== (todoist.task?.checked ?? false)) {
        await callTodoist(userId, (api) =>
          decision.snapshot.completed
            ? api.closeTask(todoistTaskId)
            : api.reopenTask(todoistTaskId),
        )
      }

      // Read back to capture the timestamp our write just produced.
      const updated = await callTodoist(userId, (api) => api.getTask(todoistTaskId))

      await upsertMapping({
        userId,
        mappingId: mapping?.id,
        glassfrogActionId: glassfrog.action.id,
        todoistTaskId,
        glassfrogUpdatedAt: decision.snapshot.updatedAt,
        todoistUpdatedAt: updated.updatedAt ?? new Date(),
        hash: contentHash(decision.snapshot),
      })

      await record(userId, 'Updated Todoist task', {
        entity: 'task',
        action: 'update',
        glassfrogActionId: glassfrog.action.id,
      })
      return
    }

    case 'update-glassfrog': {
      if (!glassfrogActionId) return

      await updateAction({
        client,
        path: { id: glassfrogActionId },
        body: {
          action_item: {
            description: decision.snapshot.content,
            note: decision.snapshot.description,
          },
        },
        throwOnError: true,
      })

      // Completion is a separate sub-resource, not a status field write.
      if (
        glassfrog.action &&
        decision.snapshot.completed !== (glassfrog.action.status === GLASSFROG_COMPLETED_STATUS)
      ) {
        if (decision.snapshot.completed) {
          await completeAction({
            client,
            path: { action_id: glassfrogActionId },
            throwOnError: true,
          })
        } else {
          await uncompleteAction({
            client,
            path: { action_id: glassfrogActionId },
            throwOnError: true,
          })
        }
      }

      const refreshed = await getAction({
        client,
        path: { id: glassfrogActionId },
        throwOnError: true,
      })

      await upsertMapping({
        userId,
        mappingId: mapping?.id,
        glassfrogActionId,
        todoistTaskId,
        glassfrogUpdatedAt: refreshed.data.data.updated_at
          ? new Date(refreshed.data.data.updated_at)
          : new Date(),
        todoistUpdatedAt: decision.snapshot.updatedAt,
        hash: contentHash(decision.snapshot),
      })

      await record(userId, 'Updated Glassfrog action', {
        entity: 'task',
        action: 'update',
        glassfrogActionId,
      })
      return
    }

    case 'delete-todoist': {
      if (todoistTaskId) {
        await callTodoist(userId, (api) => api.deleteTask(todoistTaskId))
      }
      await deleteMapping(mapping?.id)
      await record(userId, 'Deleted Todoist task', {
        entity: 'task',
        action: 'delete',
        todoistTaskId,
      })
      return
    }

    case 'delete-glassfrog': {
      if (glassfrogActionId) {
        await deleteAction({ client, path: { id: glassfrogActionId }, throwOnError: true })
      }
      await deleteMapping(mapping?.id)
      await record(userId, 'Deleted Glassfrog action', {
        entity: 'task',
        action: 'delete',
        glassfrogActionId,
      })
      return
    }
  }
}

async function findMapping(data: TaskJobData) {
  if (data.glassfrogActionId) {
    const found = await db.query.taskMapping.findFirst({
      where: and(
        eq(taskMapping.userId, data.userId),
        eq(taskMapping.glassfrogActionId, data.glassfrogActionId),
      ),
    })
    if (found) return found
  }

  if (data.todoistTaskId) {
    return db.query.taskMapping.findFirst({
      where: and(
        eq(taskMapping.userId, data.userId),
        eq(taskMapping.todoistTaskId, data.todoistTaskId),
      ),
    })
  }

  return undefined
}

async function readGlassfrogSide(
  client: Client,
  actionId: string | null,
): Promise<{ state: SideState; action: Action | null }> {
  if (!actionId) return { state: { present: false }, action: null }

  try {
    const response = await getAction({ client, path: { id: actionId }, throwOnError: true })
    const action = response.data.data

    // Cancelled and archived actions are treated as gone, so the Todoist task is removed.
    if (GLASSFROG_DEAD_STATUSES.has(action.status)) {
      return { state: { present: false }, action }
    }

    return { state: { present: true, snapshot: toGlassfrogSnapshot(action) }, action }
  } catch {
    // A 404 is the normal signal that the action was deleted.
    return { state: { present: false }, action: null }
  }
}

async function readTodoistSide(
  userId: string,
  taskId: string | null,
): Promise<{
  state: SideState
  task: { projectId: string; checked: boolean } | null
}> {
  if (!taskId) return { state: { present: false }, task: null }

  try {
    const task = await callTodoist(userId, (api) => api.getTask(taskId))

    return {
      state: {
        present: true,
        snapshot: {
          content: task.content,
          description: task.description,
          completed: task.checked,
          updatedAt: task.updatedAt ?? null,
        },
      },
      task: { projectId: task.projectId, checked: task.checked },
    }
  } catch {
    return { state: { present: false }, task: null }
  }
}

/** Finds the Todoist project an action belongs in: its parent project, else its role. */
async function resolveDestinationProject(userId: string, action: Action): Promise<string | null> {
  if (action.parent_project_id) {
    const projectRow = await db.query.projectMapping.findFirst({
      where: and(
        eq(projectMapping.userId, userId),
        eq(projectMapping.kind, 'project'),
        eq(projectMapping.glassfrogId, action.parent_project_id),
      ),
    })
    if (projectRow) return projectRow.todoistProjectId
  }

  if (!action.role_id) return null

  const roleRow = await db.query.projectMapping.findFirst({
    where: and(
      eq(projectMapping.userId, userId),
      eq(projectMapping.kind, 'role'),
      eq(projectMapping.glassfrogId, action.role_id),
    ),
  })

  return roleRow?.todoistProjectId ?? null
}

/**
 * Works out which Glassfrog role (and optionally project) a Todoist task belongs to,
 * from the project it currently sits in.
 */
async function resolveOwningRole(
  userId: string,
  todoistProjectId: string,
): Promise<{ roleGlassfrogId: string; projectGlassfrogId: string | null } | null> {
  const row = await db.query.projectMapping.findFirst({
    where: and(
      eq(projectMapping.userId, userId),
      eq(projectMapping.todoistProjectId, todoistProjectId),
    ),
  })

  if (!row) return null
  if (row.kind === 'role') return { roleGlassfrogId: row.glassfrogId, projectGlassfrogId: null }

  // A project: walk up the mapped chain to the owning role.
  let current = row
  const seen = new Set<string>([current.glassfrogId])

  while (current.parentGlassfrogId) {
    const parent = await db.query.projectMapping.findFirst({
      where: and(
        eq(projectMapping.userId, userId),
        eq(projectMapping.glassfrogId, current.parentGlassfrogId),
      ),
    })

    if (!parent || seen.has(parent.glassfrogId)) break
    seen.add(parent.glassfrogId)

    if (parent.kind === 'role') {
      return { roleGlassfrogId: parent.glassfrogId, projectGlassfrogId: row.glassfrogId }
    }
    current = parent
  }

  return null
}

async function upsertMapping(args: {
  userId: string
  mappingId?: string
  glassfrogActionId: string | null
  todoistTaskId: string | null
  glassfrogUpdatedAt: Date | null
  todoistUpdatedAt: Date | null
  hash: string
}): Promise<void> {
  const values = {
    userId: args.userId,
    glassfrogActionId: args.glassfrogActionId,
    todoistTaskId: args.todoistTaskId,
    glassfrogUpdatedAt: args.glassfrogUpdatedAt,
    todoistUpdatedAt: args.todoistUpdatedAt,
    contentHash: args.hash,
    lastSyncedAt: new Date(),
  }

  if (args.mappingId) {
    await db.update(taskMapping).set(values).where(eq(taskMapping.id, args.mappingId))
    return
  }

  await db.insert(taskMapping).values(values)
}

async function deleteMapping(mappingId?: string): Promise<void> {
  if (!mappingId) return
  await db.delete(taskMapping).where(eq(taskMapping.id, mappingId))
}

async function record(
  userId: string,
  description: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db.insert(syncLog).values({ userId, description, metadata })
}
