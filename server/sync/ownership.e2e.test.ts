import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/index.js'
import { glassfrogIntegration } from '../db/schema/integrations.js'
import { runPoll } from '../queue/jobs/poll.js'
import { getTaskQueue } from '../queue/queues.js'
import { runTaskSync } from '../queue/jobs/sync-task.js'
import {
  connectedUser,
  DatabaseSimulator,
  GlassfrogSimulator,
  ME_ACTOR_ID,
  RedisSimulator,
  TodoistSimulator,
} from '../testing/index.js'

/**
 * Two people fill the same role. Glassfrog hands both people's actions and projects to both
 * of them; each item's `actor_id` says whose it is. The mirror must contain the API-key
 * user's own and nobody else's.
 */
new DatabaseSimulator()
const glassfrog = new GlassfrogSimulator()
const todoist = new TodoistSimulator()
new RedisSimulator()

const THEM = 'per_them'
const ROOT = 'td-root'

let userId: string

const queuedTaskJobs = () => getTaskQueue().getJobs(['wait'], 0, -1, true)

async function runCycle(): Promise<void> {
  await runPoll(userId)
  const jobs = await queuedTaskJobs()
  await getTaskQueue().drain()
  for (const job of jobs) {
    await runTaskSync(job.data, job.id ?? job.name)
  }
}

const taskNames = () => todoist.tasks.filter((t) => !t.is_deleted).map((t) => t.content)
const projectNames = () => todoist.projects.map((p) => p.name)

beforeEach(async () => {
  userId = (await connectedUser({ rootProjectId: ROOT })).user.id
  todoist.addProjects([{ id: ROOT, name: 'Glassfrog' }])
  glassfrog.addRoles([
    {
      id: 'role-shared',
      name: 'Shared',
      fillers: [
        { id: ME_ACTOR_ID, type: 'actor', name: 'Me', kind: 'human' },
        { id: THEM, type: 'actor', name: 'Them', kind: 'human' },
      ],
    },
  ])
})

describe('ownership scoping', () => {
  it('mirrors only my actions and projects on a shared role', async () => {
    glassfrog.addActions([
      { id: 'a-mine', description: 'My task', role_id: 'role-shared' },
      { id: 'a-theirs', description: 'Their task', role_id: 'role-shared', actor_id: THEM },
    ])
    glassfrog.addProjects([
      { id: 'p-mine', description: 'My project', role_id: 'role-shared' },
      { id: 'p-theirs', description: 'Their project', role_id: 'role-shared', actor_id: THEM },
    ])

    await runCycle()

    expect(taskNames()).toEqual(['My task'])
    expect(projectNames()).toContain('My project')
    expect(projectNames()).not.toContain('Their project')
  })

  it("keeps a co-filler's project that one of mine sits under", async () => {
    glassfrog.addProjects([
      { id: 'p-theirs', description: 'Their project', role_id: 'role-shared', actor_id: THEM },
      {
        id: 'p-mine',
        description: 'My sub-project',
        role_id: null,
        parent_project_id: 'p-theirs',
      },
      {
        id: 'p-theirs-too',
        description: 'Their sub-project',
        role_id: null,
        parent_project_id: 'p-theirs',
        actor_id: THEM,
      },
    ])

    await runCycle()

    const parent = todoist.projects.find((p) => p.name === 'Their project')
    expect(parent).toBeDefined()
    expect(todoist.projects.find((p) => p.name === 'My sub-project')?.parent_id).toBe(parent!.id)
    expect(projectNames()).not.toContain('Their sub-project')
  })

  it('treats an item with no actor as nobody’s', async () => {
    glassfrog.addActions([
      { id: 'a-orphan', description: 'Nobody', role_id: 'role-shared', actor_id: null },
    ])

    await runCycle()

    expect(taskNames()).toEqual([])
  })

  it('removes the Todoist task once the action is handed to someone else', async () => {
    const [action] = glassfrog.addActions([
      { id: 'a-1', description: 'Handed off', role_id: 'role-shared' },
    ])
    await runCycle()
    expect(taskNames()).toEqual(['Handed off'])

    action!.actor_id = THEM
    await runCycle()

    // Only the Todoist side goes: the Glassfrog action is left alone.
    expect(taskNames()).toEqual([])
    expect(glassfrog.action('a-1')).toBeDefined()
    expect(glassfrog.deletedActionIds.has('a-1')).toBe(false)
  })

  it('reads the actor id from /me for a key saved before it was stored', async () => {
    await db
      .update(glassfrogIntegration)
      .set({ actorId: null })
      .where(eq(glassfrogIntegration.userId, userId))
    glassfrog.addActions([
      { id: 'a-mine', description: 'My task', role_id: 'role-shared' },
      { id: 'a-theirs', description: 'Their task', role_id: 'role-shared', actor_id: THEM },
    ])

    await runCycle()

    expect(taskNames()).toEqual(['My task'])
    const row = await db.query.glassfrogIntegration.findFirst({
      where: eq(glassfrogIntegration.userId, userId),
    })
    expect(row?.actorId).toBe(ME_ACTOR_ID)
  })

  it('keeps a task I create in Todoist as mine on the next poll', async () => {
    await runCycle()
    const role = todoist.projects.find((p) => p.name === 'Shared')
    expect(role).toBeDefined()
    todoist.addTasks([{ id: 'td-new', content: 'From Todoist', project_id: role!.id }])

    await runCycle()
    const created = glassfrog.actions.find((a) => a.description === 'From Todoist')
    expect(created?.actor_id).toBe(ME_ACTOR_ID)

    await runCycle()

    expect(taskNames()).toContain('From Todoist')
  })
})
