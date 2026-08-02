import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { glassfrogIntegration } from '../../db/schema/integrations.js'
import { createGlassfrogClient } from '../../glassfrog/client.js'
import { getMe } from '../../glassfrog/generated/sdk.gen.js'
import { protectedProcedure, router } from '../init.js'

export const glassfrogRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const integration = await ctx.db.query.glassfrogIntegration.findFirst({
      where: eq(glassfrogIntegration.userId, ctx.user.id),
    })

    if (!integration) return { connected: false as const }

    return { connected: true as const }
  }),

  /**
   * Validates the key against GET /me before storing it. Saving an unverified key would
   * only surface as a confusing failure in a background job later.
   */
  setApiKey: protectedProcedure
    .input(z.object({ apiKey: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const apiKey = input.apiKey.trim()

      try {
        await getMe({ client: createGlassfrogClient(apiKey), throwOnError: true })
      } catch (error) {
        ctx.logger.warn({ userId: ctx.user.id, err: error }, 'Glassfrog API key rejected')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Glassfrog rejected that API key. Check it is an API v5 key and try again.',
        })
      }

      const values = { userId: ctx.user.id, apiKey, updatedAt: new Date() }

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
