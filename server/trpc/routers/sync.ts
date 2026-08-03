import { count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { projectMapping, syncLog, taskMapping } from '../../db/schema/sync.js'
import { getPollQueue } from '../../queue/queues.js'
import { protectedProcedure, router } from '../init.js'

export const syncRouter = router({
  /** Counts backing the dashboard's status card. */
  status: protectedProcedure.query(async ({ ctx }) => {
    const [projects] = await ctx.db
      .select({ value: count() })
      .from(projectMapping)
      .where(eq(projectMapping.userId, ctx.user.id))

    const [tasks] = await ctx.db
      .select({ value: count() })
      .from(taskMapping)
      .where(eq(taskMapping.userId, ctx.user.id))

    return {
      mappedProjects: projects?.value ?? 0,
      mappedTasks: tasks?.value ?? 0,
    }
  }),

  /**
   * Queues an immediate poll instead of waiting for the next tick.
   *
   * A fixed job id makes repeated clicks idempotent while one is still pending.
   */
  triggerNow: protectedProcedure.mutation(async ({ ctx }) => {
    await getPollQueue().add(
      'poll',
      { userId: ctx.user.id },
      { jobId: `manual-poll:${ctx.user.id}:${Date.now()}` },
    )
    return { ok: true }
  }),

  recentLogs: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(syncLog)
        .where(eq(syncLog.userId, ctx.user.id))
        .orderBy(desc(syncLog.createdAt))
        .limit(input?.limit ?? 50)
    }),
})
