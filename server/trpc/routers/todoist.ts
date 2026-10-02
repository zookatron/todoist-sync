import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { todoistIntegration } from '../../db/schema/integrations.js'
import { createTodoistClient } from '../../todoist/client.js'
import { listActiveProjects } from '../../todoist/projects.js'
import { protectedProcedure, router } from '../init.js'

export const todoistRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const integration = await ctx.db.query.todoistIntegration.findFirst({
      where: eq(todoistIntegration.userId, ctx.user.id),
    })

    if (!integration) return { connected: false as const }

    return { connected: true as const, rootTodoistProjectId: integration.rootTodoistProjectId }
  }),

  /** Feeds the root-project dropdown on the dashboard. */
  listProjects: protectedProcedure.query(async ({ ctx }) => {
    const projects = await listActiveProjects(ctx.user.id)

    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      parentId: project.parentId,
    }))
  }),

  setRootProject: protectedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db
        .update(todoistIntegration)
        .set({ rootTodoistProjectId: input.projectId, updatedAt: new Date() })
        .where(eq(todoistIntegration.userId, ctx.user.id))
        .returning({ userId: todoistIntegration.userId })

      if (result.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Connect Todoist first.' })
      }

      return { ok: true }
    }),

  /**
   * Validates the token against GET /user before storing it. Saving an unverified
   * token would only surface as a confusing failure in a background job later.
   */
  setApiKey: protectedProcedure
    .input(z.object({ apiKey: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const apiKey = input.apiKey.trim()

      try {
        await createTodoistClient(apiKey).getUser()
      } catch (error) {
        ctx.logger.warn({ userId: ctx.user.id, err: error }, 'Todoist API token rejected')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Todoist rejected that token. Check it and try again.',
        })
      }

      const values = { userId: ctx.user.id, apiKey, updatedAt: new Date() }

      await ctx.db
        .insert(todoistIntegration)
        .values(values)
        .onConflictDoUpdate({ target: todoistIntegration.userId, set: values })

      return { ok: true }
    }),

  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(todoistIntegration).where(eq(todoistIntegration.userId, ctx.user.id))
    return { ok: true }
  }),
})
