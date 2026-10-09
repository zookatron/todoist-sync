import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { glassfrogIntegration, todoistIntegration } from '../../db/schema/integrations.js'
import { projectMapping, taskMapping } from '../../db/schema/sync.js'
import { getGlassfrogClient, paginateAll } from '../../glassfrog/client.js'
import { diffGlassfrogActions } from '../../glassfrog/delta.js'
import { listMyActions } from '../../glassfrog/generated/sdk.gen.js'
import type { Action } from '../../glassfrog/generated/types.gen.js'
import { getOwnership } from '../../sync/ownership.js'
import { emptyHierarchyResult, type HierarchyResult, syncHierarchy } from '../../sync/hierarchy.js'
import { callTodoist } from '../../todoist/client.js'
import { filterTodoistChanges } from '../../todoist/delta.js'
import { env } from '../../utils/env.js'
import { LockUnavailableError, withLock } from '../../utils/lock.js'
import { logger } from '../../utils/logger.js'
import { withPhase } from '../../utils/sync-context.js'
import { getTaskQueue, type TaskJobData, taskJobKey } from '../queues.js'

export type PollResult = {
  hierarchy: HierarchyResult
  enqueued: number
  skipped?: 'locked' | 'not-configured'
}

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
      () => withPhase('poll', () => poll(userId), { userId, job: 'poll' }),
    )
  } catch (error) {
    if (error instanceof LockUnavailableError) {
      log.warn('Previous poll still running; skipping this tick')
      return { hierarchy: emptyHierarchyResult(), enqueued: 0, skipped: 'locked' }
    }
    throw error
  }
}

async function poll(userId: string): Promise<PollResult> {
  const log = logger.child({ userId, job: 'poll' })

  const integration = await db.query.todoistIntegration.findFirst({
    where: eq(todoistIntegration.userId, userId),
  })

  if (!integration?.rootTodoistProjectId) {
    return { hierarchy: emptyHierarchyResult(), enqueued: 0, skipped: 'not-configured' }
  }

  const glassfrog = await db.query.glassfrogIntegration.findFirst({
    where: eq(glassfrogIntegration.userId, userId),
  })

  if (!glassfrog) {
    return { hierarchy: emptyHierarchyResult(), enqueued: 0, skipped: 'not-configured' }
  }

  // Keys saved before ownership existed have no v3 key. Syncing without one would mirror
  // co-fillers' work, so it stays off until the user adds it.
  if (!glassfrog.v3ApiKey || glassfrog.v3PersonId == null) {
    log.warn('No Glassfrog v3 API key saved; add one in settings to resume sync')
    return { hierarchy: emptyHierarchyResult(), enqueued: 0, skipped: 'not-configured' }
  }

  // Hierarchy first: task jobs must be able to find their destination project.
  const hierarchy = await withPhase('hierarchy', () => syncHierarchy(userId, { db }))

  const jobs = new Map<string, TaskJobData>()

  const glassfrogChanges = await withPhase('detect-glassfrog-changes', () =>
    detectGlassfrogChanges(userId),
  )

  for (const change of glassfrogChanges) {
    const data: TaskJobData = { userId, glassfrogActionId: change.glassfrogActionId }
    jobs.set(taskJobKey(data), data)
  }

  const todoist = await withPhase('detect-todoist-changes', () => detectTodoistChanges(userId))

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
      jobs.set(taskJobKey(merged), merged)
    } else {
      jobs.set(taskJobKey(data), data)
    }
  }

  // The map above is what collapses duplicates. BullMQ job ids are not used for this: an
  // id belonging to a failed job stays taken, which would wedge that task permanently.
  for (const data of jobs.values()) {
    await getTaskQueue().add('sync-task', data)
  }

  // Only advance the cursor once the work it produced is safely queued: a crash before
  // this point re-delivers those changes rather than dropping them.
  if (todoist.syncToken) {
    await db
      .update(todoistIntegration)
      .set({ todoistSyncToken: todoist.syncToken })
      .where(eq(todoistIntegration.userId, userId))
  }

  if (jobs.size > 0) log.info({ enqueued: jobs.size }, 'Queued task sync jobs')

  return { hierarchy, enqueued: jobs.size }
}

/** Enumerates the user's Glassfrog actions and compares them with stored timestamps. */
async function detectGlassfrogChanges(userId: string) {
  const client = await getGlassfrogClient(userId)
  const ownership = await getOwnership(userId)

  const allActions = await paginateAll<Action>(async ({ cursor, perPage }) => {
    const response = await listMyActions({
      client,
      query: { cursor, per_page: perPage, include_legacy_id: true },
      throwOnError: true,
    })
    return response.data
  })

  // /me/actions includes co-fillers' actions on shared roles. Dropping them here makes a
  // previously-mapped one read as 'missing', which removes its Todoist task (and only that:
  // sync-task never deletes the Glassfrog action).
  const ownedIds = await ownership.ownedIds('action', allActions)
  const actions = allActions.filter((action) => ownedIds.has(action.id))

  const mappings = await db
    .select({
      glassfrogActionId: taskMapping.glassfrogActionId,
      glassfrogUpdatedAt: taskMapping.glassfrogUpdatedAt,
    })
    .from(taskMapping)
    .where(eq(taskMapping.userId, userId))

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
  const integration = await db.query.todoistIntegration.findFirst({
    where: eq(todoistIntegration.userId, userId),
  })

  const response = await callTodoist(userId, (api) =>
    api.sync({
      // '*' asks for a full sync, which is what we want on the very first poll.
      syncToken: integration?.todoistSyncToken ?? '*',
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
        .where(eq(taskMapping.userId, userId))
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
