import { eq } from 'drizzle-orm'
import type IORedis from 'ioredis'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/index.js'
import { glassfrogIntegration } from '../db/schema/integrations.js'
import { runPoll } from '../queue/jobs/poll.js'
import { setConnection } from '../queue/queues.js'
import { runTaskSync } from '../queue/jobs/sync-task.js'
import {
  connectedUser,
  DatabaseSimulator,
  GlassfrogSimulator,
  QueueSimulator,
  RedisSimulator,
  TodoistSimulator,
} from '../testing/index.js'
import { OWNER_TTL_SECONDS, ownerKey } from './ownership.js'

/**
 * Two people fill the same role. Glassfrog v5 hands both people's actions and projects to
 * both of them; only v3's `links.person` says whose they are. The mirror must contain the
 * API-key user's own and nobody else's.
 */
new DatabaseSimulator()
const glassfrog = new GlassfrogSimulator()
const todoist = new TodoistSimulator()
const redis = new RedisSimulator()
const queue = new QueueSimulator()

const ME = 1
const THEM = 2
const ROOT = 'td-root'

let userId: string

async function runCycle(): Promise<void> {
  await runPoll(userId)
  await queue.drainTaskJobs(async (job) => {
    await runTaskSync(job.data, `test-${Math.random()}`)
  })
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
        { id: 'actor-1', type: 'actor', name: 'Me', kind: 'human' },
        { id: 'actor-2', type: 'actor', name: 'Them', kind: 'human' },
      ],
    },
    {
      id: 'role-solo',
      name: 'Solo',
      fillers: [{ id: 'actor-1', type: 'actor', name: 'Me', kind: 'human' }],
    },
  ])
})

describe('ownership scoping', () => {
  it('mirrors only my actions and projects on a shared role', async () => {
    const [mine, theirs] = glassfrog.addActions([
      {
        id: 'a-mine',
        description: 'My task',
        role_id: 'role-shared',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'a-theirs',
        description: 'Their task',
        role_id: 'role-shared',
        created_at: '2026-01-02T00:00:00Z',
      },
    ])
    glassfrog.addProjects([
      {
        id: 'p-mine',
        description: 'My project',
        role_id: 'role-shared',
        created_at: '2026-02-01T00:00:00Z',
      },
      {
        id: 'p-theirs',
        description: 'Their project',
        role_id: 'role-shared',
        created_at: '2026-02-02T00:00:00Z',
      },
    ])
    glassfrog.setOwner(ME, mine!.id, 'p-mine')
    glassfrog.setOwner(THEM, theirs!.id, 'p-theirs')

    await runCycle()

    expect(taskNames()).toEqual(['My task'])
    expect(projectNames()).toContain('My project')
    expect(projectNames()).not.toContain('Their project')
  })

  it('syncs my items on a role I fill alone', async () => {
    const [action] = glassfrog.addActions([
      { id: 'a-solo', description: 'Solo task', role_id: 'role-solo' },
    ])
    glassfrog.setOwner(ME, action!.id)

    await runCycle()

    expect(taskNames()).toEqual(['Solo task'])
  })

  it('does not notice a reassignment until the cached owner expires', async () => {
    const [action] = glassfrog.addActions([
      {
        id: 'a-1',
        description: 'Handed off',
        role_id: 'role-shared',
        created_at: '2026-01-01T00:00:00Z',
      },
    ])
    glassfrog.setOwner(ME, action!.id)
    await runCycle()
    expect(taskNames()).toEqual(['Handed off'])

    // Ownership is assumed to rarely change and is not re-checked.
    glassfrog.setOwner(THEM, action!.id)
    await runCycle()
    expect(taskNames()).toEqual(['Handed off'])

    // Once the entry expires the next check sees the new owner: the Todoist task is
    // removed, and the Glassfrog action is left alone.
    redis.clear()
    await runCycle()

    expect(taskNames()).toEqual([])
    expect(glassfrog.action('a-1')).toBeDefined()
    expect(glassfrog.deletedActionIds.has('a-1')).toBe(false)
  })

  it('does nothing until a v3 key is saved', async () => {
    await db
      .update(glassfrogIntegration)
      .set({ v3ApiKey: null, v3PersonId: null })
      .where(eq(glassfrogIntegration.userId, userId))
    glassfrog.addActions([
      { id: 'a-solo', description: 'Solo task', role_id: 'role-solo' },
      { id: 'a-shared', description: 'Shared task', role_id: 'role-shared' },
    ])

    const result = await runPoll(userId)

    expect(result.skipped).toBe('not-configured')
    expect(queue.taskJobs).toEqual([])
    expect(todoist.projects.map((p) => p.name)).toEqual(['Glassfrog'])
    expect(glassfrog.v3Requests).toEqual([])
  })

  it("does not treat a task I create in Todoist as someone else's on the next poll", async () => {
    await runCycle()
    const role = todoist.projects.find((p) => p.name === 'Shared')
    expect(role).toBeDefined()
    todoist.addTasks([{ id: 'td-new', content: 'From Todoist', project_id: role!.id }])

    await runCycle()
    const created = glassfrog.actions.find((a) => a.description === 'From Todoist')
    expect(created).toBeDefined()
    // Creating it recorded the user as its owner, so v3 is not asked: the entry is trusted.
    expect(redis.get(ownerKey(created!.id))).toBe(String(ME))
    glassfrog.setOwner(null, created!.id)

    await runCycle()

    expect(taskNames()).toContain('From Todoist')
  })

  describe('the owner cache in Redis', () => {
    const addMine = () => {
      const [mine] = glassfrog.addActions([
        { id: 'a-mine', description: 'My task', role_id: 'role-shared' },
      ])
      glassfrog.setOwner(ME, mine!.id)
    }

    it('stores each owner for ten days', async () => {
      addMine()
      glassfrog.addActions([{ id: 'a-orphan', description: 'Nobody', role_id: 'role-shared' }])
      glassfrog.setOwner(null, 'a-orphan')

      await runCycle()

      expect(redis.get(ownerKey('a-mine'))).toBe(String(ME))
      expect(redis.ttl(ownerKey('a-mine'))).toBe(10 * 24 * 60 * 60)
      expect(OWNER_TTL_SECONDS).toBe(864_000)
      // No owner is remembered too, so it is not looked up again.
      expect(redis.get(ownerKey('a-orphan'))).toBe('none')
    })

    it('does not ask v3 again for an item it has already checked', async () => {
      addMine()
      await runCycle()
      expect(glassfrog.v3Requests.length).toBeGreaterThan(0)

      glassfrog.v3Requests.length = 0
      await runCycle()

      expect(glassfrog.v3Requests).toEqual([])
    })

    it('trusts a cached owner over v3', async () => {
      const [theirs] = glassfrog.addActions([
        { id: 'a-theirs', description: 'Their task', role_id: 'role-shared' },
      ])
      glassfrog.setOwner(THEM, theirs!.id)
      redis.seed(ownerKey('a-theirs'), String(ME))

      await runCycle()

      expect(taskNames()).toEqual(['Their task'])
      expect(glassfrog.v3Requests).toEqual([])
    })

    it('looks up a few new items one at a time', async () => {
      addMine()

      await runPoll(userId)

      expect(glassfrog.v3Requests).toHaveLength(1)
      expect(glassfrog.v3Requests[0]).toMatch(/^GET \/api\/v3\/actions\/\d+/)
    })

    it('pages the whole list when there are many new items', async () => {
      glassfrog.addActions(
        Array.from({ length: 6 }, (_, i) => ({
          id: `a-${i}`,
          description: `Task ${i}`,
          role_id: 'role-shared',
        })),
      )
      glassfrog.setOwner(ME, ...glassfrog.actions.map((a) => a.id))

      await runPoll(userId)

      expect(glassfrog.v3Requests.filter((r) => r.includes('/actions'))).toHaveLength(1)
      expect(glassfrog.v3Requests[0]).toMatch(/^GET \/api\/v3\/actions\?/)
    })

    it('asks for a finished project by id, since the v3 list leaves them out', async () => {
      const projects = glassfrog.addProjects(
        Array.from({ length: 6 }, (_, i) => ({
          id: `p-${i}`,
          description: `Project ${i}`,
          role_id: 'role-shared',
          status: i === 5 ? ('completed' as const) : ('current' as const),
        })),
      )
      glassfrog.setOwner(THEM, ...projects.map((p) => p.id))
      glassfrog.setOwner(ME, 'p-5')

      await runPoll(userId)

      expect(glassfrog.v3Requests.filter((r) => r.includes('/projects?'))).toHaveLength(1)
      expect(glassfrog.v3Requests).toContain(
        `GET /api/v3/projects/${glassfrog.legacyIdOf('p-5')}?include=`,
      )
      expect(redis.get(ownerKey('p-5'))).toBe(String(ME))
      expect(redis.get(ownerKey('p-0'))).toBe(String(THEM))
    })

    it('treats an item v3 does not know as unowned, and remembers that', async () => {
      glassfrog.addActions([{ id: 'a-ghost', description: 'Ghost', role_id: 'role-shared' }])
      glassfrog.hiddenFromV3.add('a-ghost')

      await runCycle()

      expect(taskNames()).toEqual([])
      expect(redis.get(ownerKey('a-ghost'))).toBe('none')

      glassfrog.v3Requests.length = 0
      await runCycle()
      expect(glassfrog.v3Requests).toEqual([])
    })

    it('falls back to v3 when Redis is unavailable', async () => {
      addMine()
      setConnection({
        mget: () => Promise.reject(new Error('connection refused')),
        pipeline: () => ({ set: () => undefined, exec: () => Promise.reject(new Error('down')) }),
      } as unknown as IORedis)

      await runCycle()

      expect(taskNames()).toEqual(['My task'])
    })
  })
})
