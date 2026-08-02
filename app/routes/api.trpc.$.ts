import { getSessionUser } from '@server/auth.js'
import { logger } from '@server/logger.js'
import { createContextFactory } from '@server/trpc/init.js'
import { appRouter } from '@server/trpc/router.js'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import type { Route } from './+types/api.trpc.$'

/**
 * Mounts tRPC at /api/trpc/*. A resource route, so it renders nothing.
 *
 * Queries arrive as GET (loader) and mutations as POST (action); both hand off to the
 * same fetch adapter.
 */
async function handle(request: Request) {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext: async () => createContextFactory(await getSessionUser(request)),
    onError({ error, path }) {
      // Client errors (UNAUTHORIZED, BAD_REQUEST) are expected; only surface real faults.
      if (error.code === 'INTERNAL_SERVER_ERROR') {
        logger.error({ err: error, path }, 'tRPC request failed')
      }
    },
  })
}

export async function loader({ request }: Route.LoaderArgs) {
  return handle(request)
}

export async function action({ request }: Route.ActionArgs) {
  return handle(request)
}
