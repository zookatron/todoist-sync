import { getAuthToken } from '@doist/todoist-sdk'
import { db } from '@server/db/index.js'
import { todoistIntegration } from '@server/db/schema/integrations.js'
import { schedulePollForUser } from '@server/queue/queues.js'
import { todoistOAuthStateCookie } from '@server/todoist/oauth.js'
import { env } from '@server/utils/env.js'
import { logger } from '@server/utils/logger.js'
import { redirect } from 'react-router'
import { userContext } from '../context.js'
import { requireUser } from '../middleware/auth.js'
import type { Route } from './+types/oauth.todoist.callback'

export const middleware: Route.MiddlewareFunction[] = [requireUser]

/** Expires the state cookie: it is single-use, whether the exchange succeeded or not. */
async function clearStateCookie(): Promise<string> {
  return todoistOAuthStateCookie.serialize('', { maxAge: 0 })
}

async function failed(reason: string) {
  return redirect(`/dashboard?todoist_error=${encodeURIComponent(reason)}`, {
    headers: { 'Set-Cookie': await clearStateCookie() },
  })
}

/**
 * Step 2 of the Todoist OAuth flow: verify `state`, exchange the code for tokens, and
 * store them.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext)
  if (!user) throw redirect('/login')

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    logger.warn({ userId: user.id, error }, 'Todoist authorization was declined')
    return failed(error)
  }

  if (!code || !state) return failed('missing_code_or_state')

  // Cookie.parse is typed `any`; keep it opaque and prove it is a string before use.
  const expectedState: unknown = await todoistOAuthStateCookie.parse(request.headers.get('Cookie'))

  // The whole point of `state`: a mismatch means this callback did not originate from
  // the authorization request we started.
  if (typeof expectedState !== 'string' || expectedState !== state) {
    logger.warn({ userId: user.id }, 'Todoist OAuth state mismatch; rejecting callback')
    return failed('state_mismatch')
  }

  let token: Awaited<ReturnType<typeof getAuthToken>>
  try {
    token = await getAuthToken({
      clientId: env.TODOIST_CLIENT_ID,
      clientSecret: env.TODOIST_CLIENT_SECRET,
      code,
    })
  } catch (err) {
    logger.error({ userId: user.id, err }, 'Todoist token exchange failed')
    return failed('token_exchange_failed')
  }

  const values = {
    userId: user.id,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? null,
    expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000) : null,
    needsReauth: null,
    updatedAt: new Date(),
  }

  await db
    .insert(todoistIntegration)
    .values(values)
    .onConflictDoUpdate({ target: todoistIntegration.userId, set: values })

  await schedulePollForUser(user.id)

  logger.info(
    { userId: user.id, expiresIn: token.expiresIn, hasRefreshToken: Boolean(token.refreshToken) },
    'Connected Todoist account',
  )

  return redirect('/dashboard?todoist=connected', {
    headers: { 'Set-Cookie': await clearStateCookie() },
  })
}
