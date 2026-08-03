import { revokeToken } from '@doist/todoist-sdk'
import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { todoistIntegration } from '../../db/schema/integrations.js'
import { unschedulePollForUser } from '../../queue/queues.js'
import { callTodoist } from '../../todoist/client.js'
import { todoistTransport } from '../../todoist/transport.js'
import { env } from '../../utils/env.js'
import { protectedProcedure, router } from '../init.js'

export const todoistRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const integration = await ctx.db.query.todoistIntegration.findFirst({
      where: eq(todoistIntegration.userId, ctx.user.id),
    })

    if (!integration) return { connected: false as const }

    return {
      connected: true as const,
      expiresAt: integration.expiresAt,
      needsReauth: Boolean(integration.needsReauth),
      rootTodoistProjectId: integration.rootTodoistProjectId,
    }
  }),

  /** Feeds the root-project dropdown on the dashboard. */
  listProjects: protectedProcedure.query(async ({ ctx }) => {
    const projects = await callTodoist(ctx.user.id, async (api) => {
      const collected: { id: string; name: string; parentId: string | null }[] = []
      let cursor: string | null = null

      do {
        const page = await api.getProjects(cursor ? { cursor } : {})
        collected.push(
          ...page.results.map((project) => ({
            id: project.id,
            name: project.name,
            // Workspace projects have no parent; only personal projects nest.
            parentId: 'parentId' in project ? (project.parentId ?? null) : null,
          })),
        )
        cursor = page.nextCursor ?? null
      } while (cursor)

      return collected
    })

    return projects
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

  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    const integration = await ctx.db.query.todoistIntegration.findFirst({
      where: eq(todoistIntegration.userId, ctx.user.id),
    })

    if (integration) {
      // Best effort: a failed revoke must not block local disconnection.
      try {
        await revokeToken(
          {
            clientId: env.TODOIST_CLIENT_ID,
            clientSecret: env.TODOIST_CLIENT_SECRET,
            token: integration.accessToken,
          },
          todoistTransport(),
        )
      } catch (error) {
        ctx.logger.warn({ userId: ctx.user.id, err: error }, 'Todoist token revocation failed')
      }
    }

    await unschedulePollForUser(ctx.user.id)
    await ctx.db.delete(todoistIntegration).where(eq(todoistIntegration.userId, ctx.user.id))

    return { ok: true }
  }),
})
