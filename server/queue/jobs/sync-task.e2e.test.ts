import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/index.js'
import { todoistIntegration } from '../../db/schema/integrations.js'
import { syncLog, taskMapping } from '../../db/schema/sync.js'
import { contentHash } from '../../sync/resolve.js'
import {
  connectedUser,
  DatabaseSimulator,
  GlassfrogSimulator,
  ProjectMappingFactory,
  TaskMappingFactory,
  TodoistSimulator,
} from '../../testing/index.js'
import { acquireLock, LockUnavailableError } from '../../utils/lock.js'
import { runTaskSync } from './sync-task.js'

/**
 * `runTaskSync` end to end, one test per `resolve` branch.
 *
 * This is the module the infrastructure was built for: 484 lines interleaving Postgres,
 * both APIs and a lock, previously untested because the only alternatives were mocking the
 * layer where its bugs live or dismantling it into pure functions. Here it runs unmodified
 * and the assertions read the real resulting state on both sides.
 */
new DatabaseSimulator()
const glassfrog = new GlassfrogSimulator()
const todoist = new TodoistSimulator()

const ROOT = 'td-root'
const ROLE_GF = 'role-eng'
const ROLE_TD = 'td-project-eng'

let userId: string

beforeEach(async () => {
  const connected = await connectedUser({ rootProjectId: ROOT })
  userId = connected.user.id

  // A role already mirrored into Todoist: the destination every task resolves to.
  glassfrog.addRoles([{ id: ROLE_GF, name: 'Engineering' }])
  todoist.addProjects([
    { id: ROOT, name: 'Glassfrog' },
    { id: ROLE_TD, name: 'Engineering', parent_id: ROOT },
  ])
  await new ProjectMappingFactory().override({ userId }).forRole(ROLE_GF, ROLE_TD).make()
})

function mapping(where: { glassfrogActionId?: string; todoistTaskId?: string }) {
  return db.query.taskMapping.findFirst({
    where: and(
      eq(taskMapping.userId, userId),
      where.glassfrogActionId
        ? eq(taskMapping.glassfrogActionId, where.glassfrogActionId)
        : eq(taskMapping.todoistTaskId, where.todoistTaskId ?? ''),
    ),
  })
}

function logs() {
  return db.select().from(syncLog).where(eq(syncLog.userId, userId))
}

describe('runTaskSync', () => {
  describe('create-todoist', () => {
    it('creates a Todoist task in the mapped role project and links it', async () => {
      glassfrog.addActions([
        { id: 'action-1', description: 'Ship the thing', note: 'details', role_id: ROLE_GF },
      ])

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      const created = todoist.tasks.find((task) => task.content === 'Ship the thing')
      expect(created).toBeDefined()
      expect(created?.project_id).toBe(ROLE_TD)
      expect(created?.description).toBe('details')

      const row = await mapping({ glassfrogActionId: 'action-1' })
      expect(row?.todoistTaskId).toBe(created?.id)
      expect(row?.contentHash).toBeTruthy()
    })

    it('closes the new task when the action is already completed', async () => {
      glassfrog.addActions([
        { id: 'action-1', description: 'Already done', role_id: ROLE_GF, status: 'completed' },
      ])

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(todoist.tasks.find((task) => task.content === 'Already done')?.checked).toBe(true)
    })

    it('ignores cancelled and archived actions entirely', async () => {
      glassfrog.addActions([
        { id: 'action-1', description: 'Dropped', role_id: ROLE_GF, status: 'cancelled' },
      ])

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(todoist.tasks).toHaveLength(0)
      expect(await mapping({ glassfrogActionId: 'action-1' })).toBeUndefined()
    })

    it('skips when no Todoist project is mapped yet, leaving it for a later poll', async () => {
      glassfrog.addActions([{ id: 'action-1', description: 'Homeless', role_id: 'role-unmapped' }])

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(todoist.tasks).toHaveLength(0)
    })

    it('prefers the mapped parent project over the role', async () => {
      const PROJECT_GF = 'proj-api'
      const PROJECT_TD = 'td-project-api'
      todoist.addProjects([{ id: PROJECT_TD, name: 'API', parent_id: ROLE_TD }])
      await new ProjectMappingFactory()
        .override({ userId })
        .forProject(PROJECT_GF, PROJECT_TD, ROLE_GF)
        .make()

      glassfrog.addActions([
        {
          id: 'action-1',
          description: 'Nested',
          role_id: ROLE_GF,
          parent_project_id: PROJECT_GF,
        },
      ])

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(todoist.tasks.find((task) => task.content === 'Nested')?.project_id).toBe(PROJECT_TD)
    })
  })

  describe('create-glassfrog', () => {
    it('creates an action under the role owning the task’s project', async () => {
      const [task] = todoist.addTasks([
        { content: 'Invented in Todoist', description: 'notes', project_id: ROLE_TD },
      ])

      await runTaskSync({ userId, todoistTaskId: task!.id }, 'job-1')

      const action = glassfrog.actions.find((a) => a.description === 'Invented in Todoist')
      expect(action).toBeDefined()
      expect(action?.role_id).toBe(ROLE_GF)
      expect(action?.note).toBe('notes')

      expect((await mapping({ todoistTaskId: task!.id }))?.glassfrogActionId).toBe(action?.id)
    })

    it('walks up a nested project chain to find the owning role', async () => {
      const PROJECT_TD = 'td-project-api'
      todoist.addProjects([{ id: PROJECT_TD, name: 'API', parent_id: ROLE_TD }])
      await new ProjectMappingFactory()
        .override({ userId })
        .forProject('proj-api', PROJECT_TD, ROLE_GF)
        .make()

      const [task] = todoist.addTasks([{ content: 'Deep task', project_id: PROJECT_TD }])

      await runTaskSync({ userId, todoistTaskId: task!.id }, 'job-1')

      const action = glassfrog.actions.find((a) => a.description === 'Deep task')
      expect(action?.role_id).toBe(ROLE_GF)
      expect(action?.parent_project_id).toBe('proj-api')
    })

    it('skips a task outside any mapped project', async () => {
      todoist.addProjects([{ id: 'td-personal', name: 'Personal' }])
      const [task] = todoist.addTasks([{ content: 'Groceries', project_id: 'td-personal' }])

      await runTaskSync({ userId, todoistTaskId: task!.id }, 'job-1')

      expect(glassfrog.actions).toHaveLength(0)
    })
  })

  describe('update-todoist', () => {
    it('pushes a newer Glassfrog edit into Todoist', async () => {
      const older = new Date(Date.now() - 60_000)
      const [action] = glassfrog.addActions([
        {
          id: 'action-1',
          description: 'New title',
          note: 'New body',
          role_id: ROLE_GF,
          updated_at: new Date().toISOString(),
        },
      ])
      const [task] = todoist.addTasks([
        {
          content: 'Old title',
          description: 'Old body',
          project_id: ROLE_TD,
          updated_at: older.toISOString(),
        },
      ])
      await new TaskMappingFactory()
        .override({ userId })
        .linked(action!.id, task!.id)
        .converged({ content: 'Old title', description: 'Old body', completed: false }, older)
        .make()

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(todoist.task(task!.id)?.content).toBe('New title')
      expect(todoist.task(task!.id)?.description).toBe('New body')
    })

    it('closes the Todoist task when the action was completed', async () => {
      const older = new Date(Date.now() - 60_000)
      const [action] = glassfrog.addActions([
        { id: 'action-1', description: 'Task', role_id: ROLE_GF, status: 'completed' },
      ])
      const [task] = todoist.addTasks([
        { content: 'Task', project_id: ROLE_TD, updated_at: older.toISOString() },
      ])
      await new TaskMappingFactory()
        .override({ userId })
        .linked(action!.id, task!.id)
        .converged({ content: 'Task', description: '', completed: false }, older)
        .make()

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(todoist.task(task!.id)?.checked).toBe(true)
    })
  })

  describe('update-glassfrog', () => {
    it('pushes a newer Todoist edit into Glassfrog', async () => {
      const older = new Date(Date.now() - 60_000)
      const [action] = glassfrog.addActions([
        {
          id: 'action-1',
          description: 'Old title',
          note: 'Old body',
          role_id: ROLE_GF,
          updated_at: older.toISOString(),
        },
      ])
      const [task] = todoist.addTasks([
        {
          content: 'Newer title',
          description: 'Newer body',
          project_id: ROLE_TD,
          updated_at: new Date().toISOString(),
        },
      ])
      await new TaskMappingFactory()
        .override({ userId })
        .linked(action!.id, task!.id)
        .converged({ content: 'Old title', description: 'Old body', completed: false }, older)
        .make()

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(glassfrog.action('action-1')?.description).toBe('Newer title')
      expect(glassfrog.action('action-1')?.note).toBe('Newer body')
    })

    it('completes the action through the completion sub-resource', async () => {
      const older = new Date(Date.now() - 60_000)
      const [action] = glassfrog.addActions([
        { id: 'action-1', description: 'Task', role_id: ROLE_GF, updated_at: older.toISOString() },
      ])
      const [task] = todoist.addTasks([
        {
          content: 'Task',
          project_id: ROLE_TD,
          checked: true,
          updated_at: new Date().toISOString(),
        },
      ])
      await new TaskMappingFactory()
        .override({ userId })
        .linked(action!.id, task!.id)
        .converged({ content: 'Task', description: '', completed: false }, older)
        .make()

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(glassfrog.action('action-1')?.status).toBe('completed')
    })
  })

  describe('delete-todoist', () => {
    it('deletes the Todoist task when its linked action is gone', async () => {
      const [task] = todoist.addTasks([{ content: 'Orphan', project_id: ROLE_TD }])
      await new TaskMappingFactory().override({ userId }).linked('action-vanished', task!.id).make()

      await runTaskSync({ userId, glassfrogActionId: 'action-vanished' }, 'job-1')

      expect(todoist.deletedTaskIds.has(task!.id)).toBe(true)
      expect(await mapping({ todoistTaskId: task!.id })).toBeUndefined()
    })

    it('treats a cancelled action as deleted', async () => {
      const [action] = glassfrog.addActions([
        { id: 'action-1', description: 'Dropped', role_id: ROLE_GF, status: 'cancelled' },
      ])
      const [task] = todoist.addTasks([{ content: 'Dropped', project_id: ROLE_TD }])
      await new TaskMappingFactory().override({ userId }).linked(action!.id, task!.id).make()

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(todoist.deletedTaskIds.has(task!.id)).toBe(true)
    })
  })

  describe('delete-glassfrog', () => {
    it('deletes the action when its linked Todoist task is gone', async () => {
      glassfrog.addActions([{ id: 'action-1', description: 'Task', role_id: ROLE_GF }])
      await new TaskMappingFactory()
        .override({ userId })
        .linked('action-1', 'td-task-vanished')
        .make()

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(glassfrog.deletedActionIds.has('action-1')).toBe(true)
      expect(await mapping({ glassfrogActionId: 'action-1' })).toBeUndefined()
    })
  })

  describe('noop', () => {
    it('does nothing when neither side exists', async () => {
      await runTaskSync({ userId, glassfrogActionId: 'never-existed' }, 'job-1')

      expect(await logs()).toHaveLength(0)
    })

    it('only touches lastSyncedAt when both sides already agree', async () => {
      const snapshot = { content: 'Same', description: 'Same body', completed: false }
      const [action] = glassfrog.addActions([
        { id: 'action-1', description: 'Same', note: 'Same body', role_id: ROLE_GF },
      ])
      const [task] = todoist.addTasks([
        { content: 'Same', description: 'Same body', project_id: ROLE_TD },
      ])
      const before = await new TaskMappingFactory()
        .override({ userId })
        .linked(action!.id, task!.id)
        .converged(snapshot)
        .make()

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      const after = await mapping({ glassfrogActionId: 'action-1' })
      expect(after?.contentHash).toBe(before.contentHash)
      expect(after?.lastSyncedAt.getTime()).toBeGreaterThanOrEqual(before.lastSyncedAt.getTime())
      // No write on either side means no log entry.
      expect(await logs()).toHaveLength(0)
    })
  })

  describe('the two bugs most likely to bite', () => {
    it('does not ping-pong: our own write is not handed back as a change', async () => {
      // The first pass writes to Todoist, which bumps Todoist's updated_at past
      // Glassfrog's. A naive last-write-wins would then push that "newer" Todoist state
      // straight back to Glassfrog on the next pass, forever.
      const older = new Date(Date.now() - 60_000)
      const [action] = glassfrog.addActions([
        {
          id: 'action-1',
          description: 'Authoritative',
          note: '',
          role_id: ROLE_GF,
          updated_at: new Date().toISOString(),
        },
      ])
      const [task] = todoist.addTasks([
        { content: 'Stale', project_id: ROLE_TD, updated_at: older.toISOString() },
      ])
      await new TaskMappingFactory()
        .override({ userId })
        .linked(action!.id, task!.id)
        .converged({ content: 'Stale', description: '', completed: false }, older)
        .make()

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')
      expect(todoist.task(task!.id)?.content).toBe('Authoritative')

      const glassfrogUpdatedAt = glassfrog.action('action-1')!.updated_at
      const logsAfterFirst = (await logs()).length

      // Second pass: Todoist now looks newer, but the content is identical.
      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-2')

      expect(glassfrog.action('action-1')?.updated_at).toBe(glassfrogUpdatedAt)
      expect(glassfrog.action('action-1')?.description).toBe('Authoritative')
      expect(await logs()).toHaveLength(logsAfterFirst)
    })

    it('stores the hash of what it converged on', async () => {
      glassfrog.addActions([
        { id: 'action-1', description: 'Ship it', note: 'body', role_id: ROLE_GF },
      ])

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      const row = await mapping({ glassfrogActionId: 'action-1' })
      expect(row?.contentHash).toBe(
        // updatedAt is deliberately excluded from the hash, so any value works here.
        contentHash({ content: 'Ship it', description: 'body', completed: false, updatedAt: null }),
      )
    })

    it('refuses to run concurrently for the same task', async () => {
      // Contention here is a hard failure, not a skip: two jobs writing the same task
      // could interleave their reads and writes and lose an update. BullMQ retries.
      glassfrog.addActions([{ id: 'action-1', description: 'Contended', role_id: ROLE_GF }])
      await acquireLock(`task:${userId}:action-1`, { owner: 'someone-else', ttlMs: 60_000 })

      await expect(
        runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1'),
      ).rejects.toBeInstanceOf(LockUnavailableError)

      expect(todoist.tasks).toHaveLength(0)
    })

    it('releases its lock so the next job can run', async () => {
      glassfrog.addActions([{ id: 'action-1', description: 'Sequential', role_id: ROLE_GF }])

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      const lock = await acquireLock(`task:${userId}:action-1`, { owner: 'next', ttlMs: 1000 })
      expect(lock).not.toBeNull()
    })
  })

  describe('token expiry', () => {
    it('refreshes after a 401 and completes the write', async () => {
      glassfrog.addActions([{ id: 'action-1', description: 'Needs a token', role_id: ROLE_GF }])
      todoist.expireAccessToken()

      await runTaskSync({ userId, glassfrogActionId: 'action-1' }, 'job-1')

      expect(todoist.tasks.find((task) => task.content === 'Needs a token')).toBeDefined()

      const integration = await db.query.todoistIntegration.findFirst({
        where: eq(todoistIntegration.userId, userId),
      })
      expect(integration?.accessToken).toBe('access-token-1')
    })
  })
})
