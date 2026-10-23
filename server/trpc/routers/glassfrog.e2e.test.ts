import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../db/index.js'
import { glassfrogIntegration } from '../../db/schema/integrations.js'
import {
  DatabaseSimulator,
  GLASSFROG_TEST_API_KEY,
  GlassfrogSimulator,
  UserFactory,
} from '../../testing/index.js'
import { logger } from '../../utils/logger.js'
import { appRouter } from '../router.js'

new DatabaseSimulator()
const glassfrog = new GlassfrogSimulator()

async function caller() {
  const user = await new UserFactory().make()
  const trpc = appRouter.createCaller({ db, logger, user })
  const row = () =>
    db.query.glassfrogIntegration.findFirst({ where: eq(glassfrogIntegration.userId, user.id) })
  return { trpc, row }
}

describe('glassfrog.setApiKey', () => {
  it('saves the key and records who the user is', async () => {
    const { trpc, row } = await caller()
    glassfrog.me = { id: 'per_someone' }

    await trpc.glassfrog.setApiKey({ apiKey: GLASSFROG_TEST_API_KEY })

    expect(await row()).toMatchObject({ apiKey: GLASSFROG_TEST_API_KEY, actorId: 'per_someone' })
    expect(await trpc.glassfrog.status()).toEqual({ connected: true, initiativeRoleId: null })
  })

  it('rejects a bad key without storing it', async () => {
    const { trpc, row } = await caller()

    await expect(trpc.glassfrog.setApiKey({ apiKey: 'wrong' })).rejects.toThrow(/API v5 key/)
    expect(await row()).toBeUndefined()
    expect(await trpc.glassfrog.status()).toEqual({ connected: false })
  })
})

describe('glassfrog.setInitiativeRole', () => {
  async function connected() {
    const ctx = await caller()
    await ctx.trpc.glassfrog.setApiKey({ apiKey: GLASSFROG_TEST_API_KEY })
    glassfrog.addRoles([
      { id: 'role-mine', name: 'Mine' },
      { id: 'role-unnamed', name: null },
    ])
    return ctx
  }

  it('lists the roles I fill to choose from', async () => {
    const { trpc } = await connected()

    expect(await trpc.glassfrog.listRoles()).toEqual([
      { id: 'role-mine', name: 'Mine' },
      { id: 'role-unnamed', name: 'Untitled' },
    ])
  })

  it('saves and clears the role', async () => {
    const { trpc } = await connected()

    await trpc.glassfrog.setInitiativeRole({ roleId: 'role-mine' })
    expect(await trpc.glassfrog.status()).toEqual({
      connected: true,
      initiativeRoleId: 'role-mine',
    })

    await trpc.glassfrog.setInitiativeRole({ roleId: null })
    expect(await trpc.glassfrog.status()).toEqual({ connected: true, initiativeRoleId: null })
  })

  it('refuses a role I do not fill', async () => {
    const { trpc, row } = await connected()

    await expect(trpc.glassfrog.setInitiativeRole({ roleId: 'role-other' })).rejects.toThrow(
      /do not fill/,
    )
    expect((await row())?.initiativeRoleId).toBeNull()
  })

  it('needs Glassfrog connected first', async () => {
    const { trpc } = await caller()

    await expect(trpc.glassfrog.setInitiativeRole({ roleId: null })).rejects.toThrow(
      /Connect Glassfrog/,
    )
  })
})
