import { Button } from '@heroui/react'
import { Outlet, useNavigate } from 'react-router'
import { userContext } from '../context.js'
import { authClient } from '../lib/auth-client.js'
import { TRPCReactProvider } from '../lib/trpc.js'
import { requireUser } from '../middleware/auth.js'
import type { Route } from './+types/protected'

/**
 * Layout for authenticated routes. The middleware redirects to /login before any child
 * loader runs, so `user` below is always present.
 */
export const middleware: Route.MiddlewareFunction[] = [requireUser]

export function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext)
  return { email: user?.email ?? '' }
}

export default function ProtectedLayout({ loaderData }: Route.ComponentProps) {
  const navigate = useNavigate()

  async function handleSignOut() {
    await authClient.signOut()
    await navigate('/login')
  }

  return (
    <TRPCReactProvider>
      <div className="min-h-dvh bg-surface-secondary">
        <header className="border-default border-b bg-surface">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
            <span className="font-semibold">Todoist ⇄ Glassfrog Sync</span>
            <div className="flex items-center gap-3">
              <span className="text-foreground-secondary text-sm">{loaderData.email}</span>
              <Button variant="ghost" size="sm" onPress={handleSignOut}>
                Sign out
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-8">
          <Outlet />
        </main>
      </div>
    </TRPCReactProvider>
  )
}
