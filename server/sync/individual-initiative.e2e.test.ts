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
  RedisSimulator,
  TodoistSimulator,
} from '../testing/index.js'

/**
 * Individual initiatives belong to no role. They are mirrored directly under the configured
 * root, next to the role projects, and a task or project made inside a mirrored initiative
 * becomes one in Glassfrog.
 */
new DatabaseSimulator()
const glassfrog = new GlassfrogSimulator()
const todoist = new TodoistSimulator()
new RedisSimulator()

const ROOT = 'td-root'

let userId: string

async function runCycle(): Promise<void> {
  await runPoll(userId)
  const jobs = await getTaskQueue().getJobs(['wait'], 0, -1, true)
  await getTaskQueue().drain()
  for (const job of jobs) {
    await runTaskSync(job.data, job.id ?? job.name)
  }
}

async function chooseInitiativeRole(roleId: string | null): Promise<void> {
  await db
    .update(glassfrogIntegration)
    .set({ initiativeRoleId: roleId })
    .where(eq(glassfrogIntegration.userId, userId))
}

const liveTask = (content: string) =>
  todoist.tasks.find((t) => !t.is_deleted && t.content === content)
const projectNamed = (name: string) => todoist.projects.find((p) => p.name === name)

beforeEach(async () => {
  userId = (await connectedUser({ rootProjectId: ROOT })).user.id
  todoist.addProjects([{ id: ROOT, name: 'Glassfrog' }])
  glassfrog.addRoles([{ id: 'role-1', name: 'Role' }])
})

describe('individual initiatives', () => {
  it('puts a loose initiative action directly in the root', async () => {
    glassfrog.addActions([
      { id: 'a-ii', description: 'My initiative', role_id: 'role-1', individual_initiative: true },
    ])

    await runCycle()

    expect(liveTask('My initiative')?.project_id).toBe(ROOT)
    // Not filed under the role it was recorded against.
    expect(projectNamed('Role')).toBeDefined()
  })

  it('mirrors an initiative project under the root, with its sub-projects and actions', async () => {
    glassfrog.addProjects([
      { id: 'p-ii', description: 'Side quest', role_id: 'role-1', individual_initiative: true },
      {
        id: 'p-ii-sub',
        description: 'Side quest, part 2',
        role_id: 'role-1',
        individual_initiative: true,
        parent_project_id: 'p-ii',
      },
    ])
    glassfrog.addActions([
      {
        id: 'a-ii',
        description: 'Initiative step',
        role_id: 'role-1',
        individual_initiative: true,
        parent_project_id: 'p-ii-sub',
      },
    ])

    await runCycle()

    const project = projectNamed('Side quest')
    const sub = projectNamed('Side quest, part 2')
    expect(project?.parent_id).toBe(ROOT)
    expect(sub?.parent_id).toBe(project!.id)
    expect(liveTask('Initiative step')?.project_id).toBe(sub!.id)
  })

  it('round-trips an edit to an initiative action made in Todoist', async () => {
    glassfrog.addActions([
      { id: 'a-ii', description: 'Before', role_id: 'role-1', individual_initiative: true },
    ])
    await runCycle()

    const task = liveTask('Before')!
    task.content = 'After'
    task.checked = true
    task.updated_at = new Date(Date.now() + 1_000).toISOString()
    await runCycle()

    expect(glassfrog.action('a-ii')).toMatchObject({ description: 'After', status: 'completed' })
  })

  it('creates an initiative action from a task added inside a mirrored initiative', async () => {
    glassfrog.addProjects([
      { id: 'p-ii', description: 'Side quest', role_id: 'role-1', individual_initiative: true },
    ])
    await runCycle()

    todoist.addTasks([
      { id: 'td-new', content: 'New step', project_id: projectNamed('Side quest')!.id },
    ])
    await runCycle()

    expect(glassfrog.actions.find((a) => a.description === 'New step')).toMatchObject({
      individual_initiative: true,
      role_id: 'role-1',
      parent_project_id: 'p-ii',
    })
  })

  it('creates an initiative sub-project from a project added inside a mirrored initiative', async () => {
    glassfrog.addProjects([
      { id: 'p-ii', description: 'Side quest', role_id: 'role-1', individual_initiative: true },
    ])
    await runCycle()

    todoist.addProjects([
      { id: 'td-sub', name: 'New branch', parent_id: projectNamed('Side quest')!.id },
    ])
    await runCycle()

    expect(glassfrog.projects.find((p) => p.description === 'New branch')).toMatchObject({
      individual_initiative: true,
      role_id: 'role-1',
      parent_project_id: 'p-ii',
    })
  })

  it('leaves a task added loose in the root alone when no role is chosen for new ones', async () => {
    await runCycle()

    todoist.addTasks([{ id: 'td-loose', content: 'Loose', project_id: ROOT }])
    await runCycle()

    expect(glassfrog.actions).toEqual([])
    expect(liveTask('Loose')).toBeDefined()
  })

  it('removes the Todoist task when an initiative action is deleted', async () => {
    glassfrog.addActions([
      { id: 'a-ii', description: 'Short-lived', role_id: 'role-1', individual_initiative: true },
    ])
    await runCycle()
    expect(liveTask('Short-lived')).toBeDefined()

    glassfrog.actions = []
    await runCycle()

    expect(liveTask('Short-lived')).toBeUndefined()
  })

  describe('with a role chosen for new initiatives', () => {
    beforeEach(async () => {
      glassfrog.addRoles([{ id: 'role-2', name: 'Other role' }])
      await chooseInitiativeRole('role-2')
    })

    it('creates an initiative action from a task added loose in the root', async () => {
      await runCycle()

      todoist.addTasks([{ id: 'td-loose', content: 'Loose idea', project_id: ROOT }])
      await runCycle()

      const created = glassfrog.actions.filter((a) => a.description === 'Loose idea')
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({
        individual_initiative: true,
        role_id: 'role-2',
        parent_project_id: null,
      })

      // Stays put, and is not adopted twice.
      await runCycle()
      expect(liveTask('Loose idea')?.project_id).toBe(ROOT)
      expect(glassfrog.actions.filter((a) => a.description === 'Loose idea')).toHaveLength(1)
    })

    it('creates an initiative project from a project added in the root, and its tasks', async () => {
      await runCycle()

      todoist.addProjects([{ id: 'td-side', name: 'Side project', parent_id: ROOT }])
      await runCycle()

      const project = glassfrog.projects.find((p) => p.description === 'Side project')
      expect(project).toMatchObject({
        individual_initiative: true,
        role_id: 'role-2',
        parent_project_id: null,
      })

      todoist.addTasks([{ id: 'td-step', content: 'First step', project_id: 'td-side' }])
      await runCycle()

      expect(glassfrog.actions.find((a) => a.description === 'First step')).toMatchObject({
        individual_initiative: true,
        role_id: 'role-2',
        parent_project_id: project!.id,
      })
      // Mirrored once, in place: not rebuilt as a second project under the root.
      expect(todoist.projects.filter((p) => p.name === 'Side project')).toHaveLength(1)
      expect(projectNamed('Side project')?.parent_id).toBe(ROOT)
    })

    it('stops adopting once I no longer fill the role', async () => {
      await runCycle()
      glassfrog.roles = glassfrog.roles.filter((role) => role.id !== 'role-2')
      await runCycle()

      todoist.addTasks([{ id: 'td-loose', content: 'Loose idea', project_id: ROOT }])
      todoist.addProjects([{ id: 'td-side', name: 'Side project', parent_id: ROOT }])
      await runCycle()

      expect(glassfrog.actions).toEqual([])
      expect(glassfrog.projects).toEqual([])
    })
  })
})
