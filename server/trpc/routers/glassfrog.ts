import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { glassfrogIntegration } from '../../db/schema/integrations.js'
import { createGlassfrogClient } from '../../glassfrog/client.js'
import { getMe } from '../../glassfrog/generated/sdk.gen.js'
import { createGlassfrogV3Client, verifyV3Key } from '../../glassfrog/v3.js'
import { protectedProcedure, router } from '../init.js'

export const glassfrogRouter = router({
  /**
   * `connected` means sync can run, which needs both keys. A row saved before the v3 key
   * was required reads as `v5Saved` but not `connected`, so the UI can ask for the rest.
   */
  status: protectedProcedure.query(async ({ ctx }) => {
    const integration = await ctx.db.query.glassfrogIntegration.findFirst({
      where: eq(glassfrogIntegration.userId, ctx.user.id),
    })

    const v5Saved = Boolean(integration)
    const v3Saved = Boolean(integration?.v3ApiKey && integration.v3PersonId != null)

    return { connected: v5Saved && v3Saved, v5Saved, v3Saved }
  }),

  /**
   * Saves the v5 and v3 keys in one step. Both are required to sync: v3 is the only API that
   * records who owns an action or project, so without it a co-filler's work would be mirrored.
   *
   * Each key is verified before anything is stored: saving an unverified key would only
   * surface as a confusing failure in a background job later. Once connected, a blank field
   * keeps what is stored, so either key can be changed on its own.
   */
  setApiKeys: protectedProcedure
    .input(z.object({ apiKey: z.string().optional(), v3ApiKey: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const apiKey = input.apiKey?.trim() || undefined
      const v3ApiKey = input.v3ApiKey?.trim() || undefined

      const existing = await ctx.db.query.glassfrogIntegration.findFirst({
        where: eq(glassfrogIntegration.userId, ctx.user.id),
      })

      // The v5 key is also how we learn the v3 person id, so it is needed until that is known.
      const finalApiKey = apiKey ?? existing?.apiKey
      const finalV3Key = v3ApiKey ?? existing?.v3ApiKey
      if (!finalApiKey || (!apiKey && existing?.v3PersonId == null)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter your Glassfrog API v5 key.' })
      }
      if (!finalV3Key) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter your Glassfrog API v3 key.' })
      }

      let v3PersonId = existing?.v3PersonId ?? null

      if (apiKey) {
        try {
          // legacy_id is the v3 person id, which is how v3 ownership is matched to this user.
          const me = await getMe({
            client: createGlassfrogClient(apiKey),
            query: { include_legacy_id: true },
            throwOnError: true,
          })
          v3PersonId = me.data.data.actor.legacy_id ?? null
        } catch (error) {
          ctx.logger.warn({ userId: ctx.user.id, err: error }, 'Glassfrog API key rejected')
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Glassfrog rejected the API v5 key. Check it and try again.',
          })
        }

        if (v3PersonId == null) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'That API v5 key has no matching v3 person, so ownership cannot be determined.',
          })
        }
      }

      if (v3ApiKey) {
        try {
          await verifyV3Key(createGlassfrogV3Client(v3ApiKey))
        } catch (error) {
          ctx.logger.warn({ userId: ctx.user.id, err: error }, 'Glassfrog v3 API key rejected')
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Glassfrog rejected the API v3 key. Check it and try again.',
          })
        }
      }

      const values = {
        userId: ctx.user.id,
        apiKey: finalApiKey,
        v3ApiKey: finalV3Key,
        v3PersonId,
        updatedAt: new Date(),
      }

      await ctx.db
        .insert(glassfrogIntegration)
        .values(values)
        .onConflictDoUpdate({ target: glassfrogIntegration.userId, set: values })

      return { ok: true }
    }),

  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(glassfrogIntegration).where(eq(glassfrogIntegration.userId, ctx.user.id))
    return { ok: true }
  }),
})
