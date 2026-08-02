import type { AppRouter } from '@server/trpc/router.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import { useState } from 'react'
import superjson from 'superjson'

/**
 * tRPC v11 + TanStack Query integration.
 *
 * `useTRPC()` returns query-option builders that are passed to the native
 * `useQuery`/`useMutation` hooks — there is no `trpc.foo.useQuery()` wrapper in v11.
 */
export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>()

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The app is SSR'd; a short stale time avoids an immediate refetch on hydration.
        staleTime: 5_000,
        retry: 1,
      },
    },
  })
}

export function TRPCReactProvider({ children }: { children: React.ReactNode }) {
  // useState so each browser session gets one client, and SSR does not share one
  // QueryClient across requests.
  const [queryClient] = useState(makeQueryClient)
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: '/api/trpc', transformer: superjson })],
    }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  )
}
