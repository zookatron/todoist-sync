import type { AuthUser } from '@server/auth.js'
import { createContext } from 'react-router'

/**
 * The signed-in user, populated by `requireUser` middleware on protected routes.
 *
 * Routes behind that middleware can `context.get(userContext)` and rely on it being
 * non-null — the middleware redirects before any loader runs otherwise.
 */
export const userContext = createContext<AuthUser | null>(null)
