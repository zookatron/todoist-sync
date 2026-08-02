import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import { db } from './db/index.js'
import * as schema from './db/schema/auth.js'
import { env } from './env.js'

/**
 * Better Auth instance. Email + password only — this is a single-user, self-hosted app,
 * so there is no social login and no email verification (which would need an SMTP
 * server for no benefit here).
 *
 * Set ALLOW_SIGNUP=false once your account exists to close the instance.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
    disableSignUp: !env.ALLOW_SIGNUP,
    requireEmailVerification: false,
    minPasswordLength: 12,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh the session at most once a day
  },
  advanced: {
    useSecureCookies: env.NODE_ENV === 'production',
  },
})

export type Session = typeof auth.$Infer.Session
export type AuthUser = Session['user']

/** Resolves the signed-in user from a request, or null. */
export async function getSessionUser(request: Request): Promise<AuthUser | null> {
  const session = await auth.api.getSession({ headers: request.headers })
  return session?.user ?? null
}
