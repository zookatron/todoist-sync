import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { projectMapping, syncConfig, taskMapping } from '../../db/schema/sync.js'
import { env } from '../../env.js'
import { getGlassfrogClient, paginateAll } from '../../glassfrog/client.js'
import { diffGlassfrogActions } from '../../glassfrog/delta.js'
import { listMyActions } from '../../glassfrog/generated/sdk.gen.js'
import type { Action } from '../../glassfrog/generated/types.gen.js'
import { LockUnavailableError, withLock } from '../../lock.js'
import { logger } from '../../logger.js'
import { syncHierarchy } from '../../sync/hierarchy.js'
import { callTodoist } from '../../todoist/client.js'
import { filterTodoistChanges } from '../../todoist/delta.js'
import { type TaskJobData, taskJobId, taskQueue } from '../queues.js'

export type PollResult = {
  hierarchy: Awaited<ReturnType<typeof syncHierarchy>>
  enqueued: number
  skipped?: 'locked' | 'disabled' | 'not-configured'
}

const EMPTY_HIERARCHY = { created: 0, renamed: 0, moved: 0, archived: 0, skipped: 0 }

/**
 * One polling cycle for a user: reconcile the project tree, find changed tasks on both
 * sides, and queue one job per task.
 *
 * Held under `poll:{userId}` so a slow cycle cannot overlap the next tick. Contention
 * here is expected and benign — the job returns rather than failing.
 */
export async function runPoll(userId: string): Promise<PollResult> {
  const log = logger.child({ userId, job: 'poll' })

  try {
    return await withLock(
      `poll:${userId}`,
      { owner: `poll:${userId}`, ttlMs: env.SYNC_INTERVAL_MS * 5 },
      () => poll(userId),
    )
  } catch (error) {
    if (error instanceof LockUnavailableError) {
      log.warn('Previous poll still running; skipping this tick')
      return { hierarchy: EMPTY_HIERARCHY, enqueued: 0, skipped: 'locked' }
    }
    throw error
  }
}

async function poll(userId: string): Promise<PollResult> {
  const log = logger.child({ userId, job: 'poll' })

  const config = await db.query.syncConfig.findFirst({ where: eq(syncConfig.userId, userId) })

  if (!config?.enabled) return { hierarchy: EMPTY_HIERARCHY, enqueued: 0, skipped: 'disabled' }
  if (!config.rootTodoistProjectId) {
    return { hierarchy: EMPTY_HIERARCHY, enqueued: 0, skipped: 'not-configured' }
  }

  // Hierarchy first: task jobs must be able to find their destination project.
  const hierarchy = await syncHierarchy(userId, { db })

  const jobs = new Map<string, TaskJobData>()

  for (const change of await detectGlassfrogChanges(userId)) {
    const data: TaskJobData = { userId, glassfrogActionId: change.glassfrogActionId }
    jobs.set(taskJobId(data), data)
  }

  const todoist = await detectTodoistChanges(userId)

  for (const change of todoist.changes) {
    const data: TaskJobData = { userId, todoistTaskId: change.todoistTaskId }
    const existing = await db.query.taskMapping.findFirst({
      where: and(
        eq(taskMapping.userId, userId),
        eq(taskMapping.todoistTaskId, change.todoistTaskId),
      ),
    })

    // Prefer the Glassfrog id as the job key so a task that changed on both sides
    // collapses into a single job.
    if (existing?.glassfrogActionId) {
      const merged: TaskJobData = { userId, glassfrogActionId: existing.glassfrogActionId }
      jobs.set(taskJobId(merged), merged)
    } else {
      jobs.set(taskJobId(data), data)
    }
  }

  for (const [jobId, data] of jobs) {
    await taskQueue.add('sync-task', data, { jobId })
  }

  // Only advance the cursor once the work it produced is safely queued: a crash before
  // this point re-delivers those changes rather than dropping them.
  if (todoist.syncToken) {
    await db
      .update(syncConfig)
      .set({ todoistSyncToken: todoist.syncToken, lastPollAt: new Date() })
      .where(eq(syncConfig.userId, userId))
  } else {
    await db.update(syncConfig).set({ lastPollAt: new Date() }).where(eq(syncConfig.userId, userId))
  }

  if (jobs.size > 0) log.info({ enqueued: jobs.size }, 'Queued task sync jobs')

  return { hierarchy, enqueued: jobs.size }
}

/** Enumerates the user's Glassfrog actions and compares them with stored timestamps. */
async function detectGlassfrogChanges(userId: string) {
  const client = await getGlassfrogClient(userId)

  const actions = await paginateAll<Action>(async ({ cursor, perPage }) => {
    const response = await listMyActions({
      client,
      query: { cursor, per_page: perPage },
      throwOnError: true,
    })
    return response.data
  })

  const mappings = await db
    .select({
      glassfrogActionId: taskMapping.glassfrogActionId,
      glassfrogUpdatedAt: taskMapping.glassfrogUpdatedAt,
    })
    .from(taskMapping)
    .where(and(eq(taskMapping.userId, userId), isNull(taskMapping.deletedAt)))

  return diffGlassfrogActions({
    actions: actions.map((action) => ({ id: action.id, updated_at: action.updated_at })),
    mappings: mappings
      .filter((m): m is { glassfrogActionId: string; glassfrogUpdatedAt: Date | null } =>
        Boolean(m.glassfrogActionId),
      )
      .map((m) => ({
        glassfrogActionId: m.glassfrogActionId,
        glassfrogUpdatedAt: m.glassfrogUpdatedAt,
      })),
  })
}

/** Pulls the incremental Todoist delta and narrows it to the mirrored tree. */
async function detectTodoistChanges(userId: string) {
  const config = await db.query.syncConfig.findFirst({ where: eq(syncConfig.userId, userId) })

  const response = await callTodoist(userId, (api) =>
    api.sync({
      // '*' asks for a full sync, which is what we want on the very first poll.
      syncToken: config?.todoistSyncToken ?? '*',
      resourceTypes: ['items'],
    }),
  )

  const mappedProjectIds = new Set(
    (
      await db
        .select({ todoistProjectId: projectMapping.todoistProjectId })
        .from(projectMapping)
        .where(eq(projectMapping.userId, userId))
    ).map((row) => row.todoistProjectId),
  )

  const trackedTaskIds = new Set(
    (
      await db
        .select({ todoistTaskId: taskMapping.todoistTaskId })
        .from(taskMapping)
        .where(and(eq(taskMapping.userId, userId), isNull(taskMapping.deletedAt)))
    )
      .map((row) => row.todoistTaskId)
      .filter((id): id is string => Boolean(id)),
  )

  const changes = filterTodoistChanges({
    items: (response.items ?? []).map((item) => ({
      id: item.id,
      projectId: item.projectId,
      updatedAt: item.updatedAt ?? null,
      isDeleted: item.isDeleted,
    })),
    mappedProjectIds,
    trackedTaskIds,
  })

  return { changes, syncToken: response.syncToken }
}
