import { getSessionUser } from '@server/auth.js'
import type { MiddlewareFunction } from 'react-router'
import { redirect } from 'react-router'
import { userContext } from '../context.js'

/**
 * Blocks unauthenticated requests and puts the user on the router context.
 *
 * Applied to the protected route branch in `app/routes.ts`, so every loader beneath it
 * can read `context.get(userContext)` without re-checking the session.
 *
 * Typed as `MiddlewareFunction<Response>` rather than bare `MiddlewareFunction`: the
 * latter defaults its result to `unknown`, which is not assignable to the per-route
 * `Route.MiddlewareFunction` that route modules expect.
 */
export const requireUser: MiddlewareFunction<Response> = async ({ request, context }) => {
  const user = await getSessionUser(request)

  if (!user) {
    const url = new URL(request.url)
    // Preserve where they were headed so login can send them back.
    const redirectTo = `${url.pathname}${url.search}`
    const params = redirectTo === '/' ? '' : `?redirectTo=${encodeURIComponent(redirectTo)}`
    throw redirect(`/login${params}`)
  }

  context.set(userContext, user)
}
