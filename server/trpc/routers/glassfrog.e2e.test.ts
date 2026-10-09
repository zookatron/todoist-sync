import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../db/index.js'
import { glassfrogIntegration } from '../../db/schema/integrations.js'
import {
  DatabaseSimulator,
  GLASSFROG_TEST_API_KEY,
  GlassfrogIntegrationFactory,
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
  return { trpc, row, userId: user.id }
}

describe('glassfrog.setApiKeys', () => {
  it('saves both keys in one step and records who the user is', async () => {
    const { trpc, row } = await caller()
    glassfrog.me = { id: 'actor-1', legacyId: 77 }

    await trpc.glassfrog.setApiKeys({
      apiKey: GLASSFROG_TEST_API_KEY,
      v3ApiKey: GLASSFROG_TEST_API_KEY,
    })

    expect(await row()).toMatchObject({
      apiKey: GLASSFROG_TEST_API_KEY,
      v3ApiKey: GLASSFROG_TEST_API_KEY,
      v3PersonId: 77,
    })
    expect(await trpc.glassfrog.status()).toEqual({ connected: true, v5Saved: true, v3Saved: true })
  })

  it('requires the v3 key to connect', async () => {
    const { trpc, row } = await caller()

    await expect(trpc.glassfrog.setApiKeys({ apiKey: GLASSFROG_TEST_API_KEY })).rejects.toThrow(
      /v3 key/,
    )
    expect(await row()).toBeUndefined()
  })

  it('asks a user saved before v3 keys were required to add one', async () => {
    const { trpc, userId } = await caller()
    await new GlassfrogIntegrationFactory().withoutV3Key().override({ userId }).make()
    expect(await trpc.glassfrog.status()).toEqual({
      connected: false,
      v5Saved: true,
      v3Saved: false,
    })

    // The v3 key alone is not enough: the v5 key is how the v3 person id is learned.
    await expect(trpc.glassfrog.setApiKeys({ v3ApiKey: GLASSFROG_TEST_API_KEY })).rejects.toThrow(
      /v5 key/,
    )

    await trpc.glassfrog.setApiKeys({
      apiKey: GLASSFROG_TEST_API_KEY,
      v3ApiKey: GLASSFROG_TEST_API_KEY,
    })
    expect(await trpc.glassfrog.status()).toEqual({ connected: true, v5Saved: true, v3Saved: true })
  })

  it('rejects a bad v3 key without storing the v5 key either', async () => {
    const { trpc, row } = await caller()

    await expect(
      trpc.glassfrog.setApiKeys({ apiKey: GLASSFROG_TEST_API_KEY, v3ApiKey: 'wrong' }),
    ).rejects.toThrow(/API v3 key/)
    expect(await row()).toBeUndefined()
  })

  it('rejects a bad v5 key', async () => {
    const { trpc, row } = await caller()

    await expect(
      trpc.glassfrog.setApiKeys({ apiKey: 'wrong', v3ApiKey: GLASSFROG_TEST_API_KEY }),
    ).rejects.toThrow(/API v5 key/)
    expect(await row()).toBeUndefined()
  })

  it('changes the v3 key on its own once connected', async () => {
    const { trpc, row } = await caller()
    await trpc.glassfrog.setApiKeys({
      apiKey: GLASSFROG_TEST_API_KEY,
      v3ApiKey: GLASSFROG_TEST_API_KEY,
    })

    await expect(trpc.glassfrog.setApiKeys({ v3ApiKey: 'wrong' })).rejects.toThrow(/API v3 key/)
    await trpc.glassfrog.setApiKeys({ v3ApiKey: GLASSFROG_TEST_API_KEY })

    expect(await row()).toMatchObject({ apiKey: GLASSFROG_TEST_API_KEY, v3PersonId: 1 })
  })

  it('keeps the saved v3 key when only the v5 key is changed', async () => {
    const { trpc, row } = await caller()
    await trpc.glassfrog.setApiKeys({
      apiKey: GLASSFROG_TEST_API_KEY,
      v3ApiKey: GLASSFROG_TEST_API_KEY,
    })

    await trpc.glassfrog.setApiKeys({ apiKey: GLASSFROG_TEST_API_KEY, v3ApiKey: '' })

    expect(await row()).toMatchObject({ v3ApiKey: GLASSFROG_TEST_API_KEY })
  })
})
