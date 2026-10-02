import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/index.js'
import { todoistIntegration } from '../../db/schema/integrations.js'
import { projectMapping, taskMapping } from '../../db/schema/sync.js'
import {
  connectedUser,
  DatabaseSimulator,
  GlassfrogSimulator,
  ProjectMappingFactory,
  QueueSimulator,
  TodoistSimulator,
} from '../../testing/index.js'
import { acquireLock } from '../../utils/lock.js'
import { runPoll } from './poll.js'
import { runTaskSync } from './sync-task.js'

/**
 * `runPoll` end to end — the whole cycle, the way the worker runs it.
 *
 * The case this file exists for is the full Todoist-first journey: a project and a task both
 * created in Todoist have to travel through the hierarchy pass (which adopts the project and
 * writes its mapping) and then the task pass (which resolves that brand-new mapping up to an
 * owning role). Neither half proves that on its own.
 */
new DatabaseSimulator()
const glassfrog = new GlassfrogSimulator()
const todoist = new TodoistSimulator()
const queue = new QueueSimulator()

const ROOT = 'td-root'
const ROLE_GF = 'role-eng'
const ROLE_TD = 'td-eng'

let userId: string

beforeEach(async () => {
  userId = (await connectedUser({ rootProjectId: ROOT })).user.id

  // A role already mirrored on both sides: roles only ever come from Glassfrog.
  glassfrog.addRoles([{ id: ROLE_GF, name: 'Engineering' }])
  todoist.addProjects([
    { id: ROOT, name: 'Glassfrog' },
    { id: ROLE_TD, name: 'Engineering', parent_id: ROOT },
  ])
  await new ProjectMappingFactory().override({ userId }).forRole(ROLE_GF, ROLE_TD).make()
})

/** Runs a poll and then applies every task job it produced, as the worker would. */
async function runCycle(): Promise<void> {
  await runPoll(userId)
  await queue.drainTaskJobs(async (job) => {
    await runTaskSync(job.data, `test-${Math.random()}`)
  })
}

describe('runPoll', () => {
  it('skips a user who has not finished connecting', async () => {
    await db.update(todoistIntegration).set({ rootTodoistProjectId: null })

    const result = await runPoll(userId)

    expect(result.skipped).toBe('not-configured')
    expect(queue.taskJobs).toHaveLength(0)
  })

  it('exits cleanly when a previous poll is still running', async () => {
    await acquireLock(`poll:${userId}`, { owner: 'someone-else', ttlMs: 60_000 })

    const result = await runPoll(userId)

    expect(result.skipped).toBe('locked')
  })

  it('carries a project and its task from Todoist into Glassfrog in one cycle', async () => {
    // Everything the user did: made a project inside their role, and put a task in it.
    todoist.addProjects([{ id: 'td-new', name: 'Rebrand', parent_id: ROLE_TD }])
    todoist.addTasks([{ id: 'td-task', content: 'Draft the brief', project_id: 'td-new' }])

    await runCycle()

    const project = glassfrog.projects.find((p) => p.description === 'Rebrand')
    expect(project).toBeDefined()
    expect(project?.role_id).toBe(ROLE_GF)
    expect(project?.status).toBe('current')

    const action = glassfrog.actions.find((a) => a.description === 'Draft the brief')
    expect(action).toBeDefined()
    // The action lands on the project adopted moments earlier in the same cycle.
    expect(action?.parent_project_id).toBe(project!.id)
    expect(action?.role_id).toBe(ROLE_GF)

    const mappings = await db.select().from(projectMapping).where(eq(projectMapping.userId, userId))
    expect(mappings.map((m) => m.todoistProjectId)).toContain('td-new')

    const tasks = await db.select().from(taskMapping).where(eq(taskMapping.userId, userId))
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ todoistTaskId: 'td-task', glassfrogActionId: action!.id })
  })

  it('settles: a second cycle over the same state changes nothing', async () => {
    todoist.addProjects([{ id: 'td-new', name: 'Rebrand', parent_id: ROLE_TD }])
    todoist.addTasks([{ id: 'td-task', content: 'Draft the brief', project_id: 'td-new' }])

    await runCycle()
    const projectsAfterFirst = glassfrog.projects.length
    const actionsAfterFirst = glassfrog.actions.length

    await runCycle()

    // The adopted project and its action come back as "changes" — our own writes bumped
    // their timestamps — and must not be duplicated.
    expect(glassfrog.projects).toHaveLength(projectsAfterFirst)
    expect(glassfrog.actions).toHaveLength(actionsAfterFirst)
    expect(todoist.projects.filter((p) => p.name === 'Rebrand')).toHaveLength(1)
  })

  it('completes the Glassfrog project when the user archives it in Todoist', async () => {
    todoist.addProjects([{ id: 'td-new', name: 'Rebrand', parent_id: ROLE_TD }])
    await runCycle()

    const project = glassfrog.projects.find((p) => p.description === 'Rebrand')!

    const mirror = todoist.project('td-new')!
    mirror.is_archived = true
    mirror.updated_at = new Date(Date.now() + 60_000).toISOString()

    await runCycle()

    expect(glassfrog.project(project.id)?.status).toBe('completed')
  })

  it('advances the Todoist sync cursor only after its jobs are queued', async () => {
    todoist.addTasks([{ id: 'td-task', content: 'Something', project_id: ROLE_TD }])

    await runPoll(userId)

    const integration = await db.query.todoistIntegration.findFirst({
      where: eq(todoistIntegration.userId, userId),
    })
    expect(integration?.todoistSyncToken).toBeTruthy()
    expect(queue.taskJobs).toHaveLength(1)
  })

  it('collapses a task that changed on both sides into one job', async () => {
    glassfrog.addActions([{ id: 'action-1', description: 'Shared', role_id: ROLE_GF }])
    todoist.addTasks([{ id: 'td-task', content: 'Shared', project_id: ROLE_TD }])
    await runCycle()

    // Touch both sides, then poll: one job, keyed by the Glassfrog id.
    glassfrog.actions[0]!.description = 'Shared, changed in Glassfrog'
    glassfrog.actions[0]!.updated_at = new Date(Date.now() + 60_000).toISOString()
    const task = todoist.task('td-task')!
    task.content = 'Shared, changed in Todoist'
    task.updated_at = new Date(Date.now() + 60_000).toISOString()

    await runPoll(userId)

    expect(queue.taskJobs).toHaveLength(1)
    expect(queue.taskJobs[0]?.data).toEqual({ userId, glassfrogActionId: 'action-1' })
  })
})
