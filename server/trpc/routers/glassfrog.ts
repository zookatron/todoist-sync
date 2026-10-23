import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { glassfrogIntegration } from '../../db/schema/integrations.js'
import { createGlassfrogClient, getGlassfrogClient, paginateAll } from '../../glassfrog/client.js'
import { getMe, listMyRoles } from '../../glassfrog/generated/sdk.gen.js'
import type { Role } from '../../glassfrog/generated/types.gen.js'
import { toProjectName } from '../../sync/desired-tree.js'
import { protectedProcedure, router } from '../init.js'

export const glassfrogRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const integration = await ctx.db.query.glassfrogIntegration.findFirst({
      where: eq(glassfrogIntegration.userId, ctx.user.id),
    })

    if (!integration) return { connected: false as const }

    return { connected: true as const, initiativeRoleId: integration.initiativeRoleId }
  }),

  /** Feeds the new-initiative role dropdown: the roles the user fills. */
  listRoles: protectedProcedure.query(async ({ ctx }) => {
    const roles = await listFilledRoles(ctx.user.id)
    // Named as their Todoist role projects are, so the two lists read the same.
    return roles.map((role) => ({ id: role.id, name: toProjectName(role.name) }))
  }),

  /**
   * Chooses the role new individual initiatives are recorded against, or null for none.
   * Glassfrog creates anything through a role, so this is what lets a task or project added
   * loose in the Todoist root become an initiative. Checked against the roles the user fills,
   * since creating through any other is refused.
   */
  setInitiativeRole: protectedProcedure
    .input(z.object({ roleId: z.string().min(1).nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (input.roleId) {
        const roles = await listFilledRoles(ctx.user.id)
        if (!roles.some((role) => role.id === input.roleId)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'You do not fill that role.' })
        }
      }

      const result = await ctx.db
        .update(glassfrogIntegration)
        .set({ initiativeRoleId: input.roleId, updatedAt: new Date() })
        .where(eq(glassfrogIntegration.userId, ctx.user.id))
        .returning({ userId: glassfrogIntegration.userId })

      if (result.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Connect Glassfrog first.' })
      }

      return { ok: true }
    }),

  /**
   * Validates the key against GET /me before storing it. Saving an unverified key would
   * only surface as a confusing failure in a background job later.
   *
   * The same call says who the key belongs to: the actor id stored with it is what decides
   * which actions and projects are the user's.
   */
  setApiKey: protectedProcedure
    .input(z.object({ apiKey: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const apiKey = input.apiKey.trim()

      let actorId: string
      try {
        const me = await getMe({ client: createGlassfrogClient(apiKey), throwOnError: true })
        actorId = me.data.data.actor.id
      } catch (error) {
        ctx.logger.warn({ userId: ctx.user.id, err: error }, 'Glassfrog API key rejected')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Glassfrog rejected that API key. Check it is an API v5 key and try again.',
        })
      }

      const values = { userId: ctx.user.id, apiKey, actorId, updatedAt: new Date() }

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

async function listFilledRoles(userId: string): Promise<Role[]> {
  const client = await getGlassfrogClient(userId)
  return paginateAll<Role>(async ({ cursor, perPage }) => {
    const response = await listMyRoles({
      client,
      query: { cursor, per_page: perPage },
      throwOnError: true,
    })
    return response.data
  })
}
