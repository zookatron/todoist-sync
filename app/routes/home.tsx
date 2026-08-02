import { getSessionUser } from '@server/auth.js'
import { redirect } from 'react-router'
import type { Route } from './+types/home'

/** The root path is just a signpost: straight to the dashboard, or to login. */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await getSessionUser(request)
  return redirect(user ? '/dashboard' : '/login')
}
