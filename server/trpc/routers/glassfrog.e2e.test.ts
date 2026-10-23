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
    expect(await trpc.glassfrog.status()).toEqual({ connected: true })
  })

  it('rejects a bad key without storing it', async () => {
    const { trpc, row } = await caller()

    await expect(trpc.glassfrog.setApiKey({ apiKey: 'wrong' })).rejects.toThrow(/API v5 key/)
    expect(await row()).toBeUndefined()
    expect(await trpc.glassfrog.status()).toEqual({ connected: false })
  })
})
