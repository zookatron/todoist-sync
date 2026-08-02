import { getAuthorizationUrl, getAuthStateParameter } from '@doist/todoist-sdk'
import { env } from '@server/env.js'
import { TODOIST_SCOPES, todoistOAuthStateCookie } from '@server/todoist/oauth.js'
import { redirect } from 'react-router'
import { requireUser } from '../middleware/auth.js'
import type { Route } from './+types/oauth.todoist.start'

export const middleware: Route.MiddlewareFunction[] = [requireUser]

/**
 * Step 1 of the Todoist OAuth flow: stash a CSRF `state` in a signed cookie and send the
 * user to Todoist's consent screen.
 */
export async function loader(_: Route.LoaderArgs) {
  const state = getAuthStateParameter()

  const authorizationUrl = getAuthorizationUrl({
    clientId: env.TODOIST_CLIENT_ID,
    permissions: TODOIST_SCOPES,
    state,
  })

  return redirect(authorizationUrl, {
    headers: { 'Set-Cookie': await todoistOAuthStateCookie.serialize(state) },
  })
}
