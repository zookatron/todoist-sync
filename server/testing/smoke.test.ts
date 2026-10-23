import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../db/index.js'
import { todoistIntegration } from '../db/schema/integrations.js'
import { user } from '../db/schema/auth.js'
import { getGlassfrogClient } from '../glassfrog/client.js'
import { listMyRoles } from '../glassfrog/generated/sdk.gen.js'
import { getPollQueue, getTaskQueue, scheduleGlobalPoll } from '../queue/queues.js'
import { callTodoist } from '../todoist/client.js'
import {
  connectedUser,
  DatabaseSimulator,
  GlassfrogSimulator,
  RedisSimulator,
  TodoistSimulator,
  UserFactory,
} from './index.js'

/**
 * Proves the infrastructure itself works: PGlite behind the app's `db`, both APIs answered
 * from memory, and BullMQ running on an in-memory Redis rather than dialling a real one.
 * Every other test in the suite rests on these four assumptions.
 */
const database = new DatabaseSimulator()
const glassfrog = new GlassfrogSimulator()
const todoist = new TodoistSimulator()
const redis = new RedisSimulator()

describe('DatabaseSimulator', () => {
  it('runs the real migrations and serves the application db', async () => {
    const created = await new UserFactory().make()

    // Written through the factory (which uses the app's `db`), read back through the
    // simulator's own handle: same database, so the substitution really took.
    const rows = await database.db.select().from(user)

    expect(created.id).toBe('user-1')
    expect(rows.map((row) => row.id)).toEqual(['user-1'])
  })

  it('empties every table between tests', async () => {
    // `user-1` again proves both the truncate and the sequence reset happened.
    const created = await new UserFactory().make()
    expect(created.id).toBe('user-1')
  })

  it('enforces the real schema, including foreign keys', async () => {
    await expect(
      db.insert(todoistIntegration).values({ userId: 'ghost', apiKey: 'x' }),
    ).rejects.toThrow()
  })
})

describe('GlassfrogSimulator', () => {
  it('answers the generated client from in-memory state', async () => {
    const { user } = await connectedUser()
    glassfrog.addRoles([{ name: 'Engineer' }, { name: 'Designer' }])

    const client = await getGlassfrogClient(user.id)
    const response = await listMyRoles({ client, throwOnError: true })

    expect(response.data.data.map((role) => role.name)).toEqual(['Engineer', 'Designer'])
  })

  it('rejects an unknown API key', async () => {
    const { user } = await connectedUser()
    await db
      .update(todoistIntegration)
      .set({ apiKey: 'unused' })
      .where(eq(todoistIntegration.userId, user.id))

    const client = await getGlassfrogClient(user.id)
    client.setConfig({ ...client.getConfig(), headers: { 'X-Auth-Token': 'wrong' } })

    await expect(listMyRoles({ client, throwOnError: true })).rejects.toBeDefined()
  })
})

describe('TodoistSimulator', () => {
  it('serves the real SDK through msw, converting snake_case to camelCase', async () => {
    const { user } = await connectedUser()
    todoist.addProjects([{ id: 'td-root', name: 'Root' }])

    const page = await callTodoist(user.id, (api) => api.getProjects({}))

    expect(page.results.map((project) => project.name)).toEqual(['Root'])
    // `parent_id` on the wire, `parentId` after the SDK: proof the real conversion ran.
    expect(page.results[0]).toHaveProperty('parentId', null)
  })

  it('applies writes to its store', async () => {
    const { user } = await connectedUser()
    todoist.addProjects([{ id: 'td-root', name: 'Root' }])

    const created = await callTodoist(user.id, (api) =>
      api.addTask({ content: 'Write tests', projectId: 'td-root' }),
    )

    expect(todoist.task(created.id)?.content).toBe('Write tests')
  })
})

describe('RedisSimulator', () => {
  it('runs the real BullMQ queues', async () => {
    await getTaskQueue().add('sync-task', { userId: 'u1', glassfrogActionId: 'a1' })
    await getTaskQueue().add('sync-task', { userId: 'u1', todoistTaskId: 't1' })

    const jobs = await getTaskQueue().getJobs(['wait'], 0, -1, true)
    expect(jobs.map((job) => job.data)).toEqual([
      { userId: 'u1', glassfrogActionId: 'a1' },
      { userId: 'u1', todoistTaskId: 't1' },
    ])
    // The default job options really reached Redis, msgpacked, and came back out.
    expect(jobs[0]?.opts.attempts).toBe(3)
  })

  it('runs job schedulers, millisecond timestamps included', async () => {
    await scheduleGlobalPoll()

    const [scheduler] = await getPollQueue().getJobSchedulers()
    expect(scheduler).toMatchObject({ key: 'global-poll', name: 'poll-tick' })
    // A 32-bit overflow anywhere in the scheduler script would land this far from now.
    expect(Math.abs(scheduler!.next! - Date.now())).toBeLessThan(10 * 60_000)
    // An `every` scheduler runs its first iteration straight away.
    const [tick] = await getPollQueue().getJobs(['wait'])
    expect(tick?.name).toBe('poll-tick')
  })

  it('empties Redis between tests', async () => {
    expect(await redis.client.keys('*')).toEqual([])
  })

  it('can fail a command for one test', async () => {
    redis.failForTest('get')

    await expect(redis.client.get('anything')).rejects.toThrow('Connection is closed.')
  })

  it('restores failed commands afterwards', async () => {
    expect(await redis.client.get('anything')).toBeNull()
  })
})
