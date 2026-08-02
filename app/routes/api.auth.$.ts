import { auth } from '@server/utils/auth.js'
import type { Route } from './+types/api.auth.$'

/**
 * Mounts the Better Auth handler at /api/auth/*.
 *
 * A resource route: no default export, so it renders nothing and simply returns the
 * handler's Response. GETs (session, callbacks) hit the loader; POSTs (sign in, sign up,
 * sign out) hit the action.
 */
export async function loader({ request }: Route.LoaderArgs) {
  return auth.handler(request)
}

export async function action({ request }: Route.ActionArgs) {
  return auth.handler(request)
}
