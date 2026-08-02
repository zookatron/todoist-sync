import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../../db/index.js'
import { syncConfig } from '../../db/schema/sync.js'
import { schedulePollForUser, unschedulePollForUser } from '../../queue/queues.js'
import { protectedProcedure, router } from '../init.js'

type ConfigContext = { db: Database; user: { id: string } }

/** Reads the user's sync config, creating the row on first access. */
async function getOrCreateConfig(ctx: ConfigContext) {
  const existing = await ctx.db.query.syncConfig.findFirst({
    where: eq(syncConfig.userId, ctx.user.id),
  })

  if (existing) return existing

  const [created] = await ctx.db
    .insert(syncConfig)
    .values({ userId: ctx.user.id })
    .onConflictDoNothing()
    .returning()

  // A concurrent request may have won the insert; re-read in that case.
  return (
    created ??
    (await ctx.db.query.syncConfig.findFirst({ where: eq(syncConfig.userId, ctx.user.id) }))
  )
}

export const configRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const config = await getOrCreateConfig(ctx)

    return {
      rootTodoistProjectId: config?.rootTodoistProjectId ?? null,
      enabled: config?.enabled ?? false,
      pruneMode: config?.pruneMode ?? null,
      lastPollAt: config?.lastPollAt ?? null,
      lastHierarchySyncAt: config?.lastHierarchySyncAt ?? null,
    }
  }),

  setRootProject: protectedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await getOrCreateConfig(ctx)

      await ctx.db
        .update(syncConfig)
        .set({
          rootTodoistProjectId: input.projectId,
          // The mirrored tree is rebuilt beneath the new root, so the previous
          // hierarchy timestamp no longer describes anything.
          lastHierarchySyncAt: null,
          updatedAt: new Date(),
        })
        .where(eq(syncConfig.userId, ctx.user.id))

      return { ok: true }
    }),

  setEnabled: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await getOrCreateConfig(ctx)

      await ctx.db
        .update(syncConfig)
        .set({ enabled: input.enabled, updatedAt: new Date() })
        .where(eq(syncConfig.userId, ctx.user.id))

      // Register or tear down the recurring poll immediately, so toggling here takes
      // effect without restarting the worker.
      if (input.enabled) {
        await schedulePollForUser(ctx.user.id)
      } else {
        await unschedulePollForUser(ctx.user.id)
      }

      return { ok: true }
    }),
})
