import type { Permission } from '@doist/todoist-sdk'
import { createCookie } from 'react-router'
import { env } from '../env.js'

/**
 * Scopes requested during authorization.
 *
 * - `data:read_write` — read and write tasks and projects
 * - `data:delete`     — delete tasks (deletion is two-way in this app)
 * - `project:delete`  — archive projects that no longer map to Glassfrog
 */
export const TODOIST_SCOPES: readonly Permission[] = [
  'data:read_write',
  'data:delete',
  'project:delete',
]

/**
 * Holds the OAuth `state` between the redirect out and the callback back.
 *
 * Signed and httpOnly: `state` is CSRF protection, so a value the browser could forge
 * would defeat the point. Short-lived because it only has to survive one round trip.
 */
export const todoistOAuthStateCookie = createCookie('todoist_oauth_state', {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
  maxAge: 60 * 10,
  secrets: [env.BETTER_AUTH_SECRET],
})
