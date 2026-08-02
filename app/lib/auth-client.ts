import { createAuthClient } from 'better-auth/react'

/**
 * Browser-side auth client. Same-origin, so no baseURL is needed — the Better Auth
 * handler is mounted at /api/auth/* by app/routes/api.auth.$.ts.
 */
export const authClient = createAuthClient()

export const { signIn, signUp, signOut, useSession } = authClient
