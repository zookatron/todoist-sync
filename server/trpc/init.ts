import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import type { AuthUser } from '../auth.js'
import { type Database, db } from '../db/index.js'
import { type Logger, logger } from '../logger.js'

export type TRPCContext = {
  db: Database
  logger: Logger
  user: AuthUser | null
}

/** Builds the per-request context. Session resolution happens in the route handler. */
export function createContextFactory(user: AuthUser | null): TRPCContext {
  return { db, logger, user }
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
})

export const router = t.router
export const publicProcedure = t.procedure

/**
 * Requires a signed-in user. Narrows `ctx.user` to non-null for the procedure body, so
 * downstream code never has to re-check.
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }

  return next({ ctx: { ...ctx, user: ctx.user } })
})
