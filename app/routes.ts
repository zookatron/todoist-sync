import { index, layout, type RouteConfig, route } from '@react-router/dev/routes'

export default [
  index('routes/home.tsx'),

  route('login', 'routes/login.tsx'),
  route('signup', 'routes/signup.tsx'),

  // Everything below requireUser middleware; see routes/protected.tsx.
  layout('routes/protected.tsx', [route('dashboard', 'routes/dashboard.tsx')]),

  // Todoist OAuth (authenticated, but no UI of their own).
  route('oauth/todoist/start', 'routes/oauth.todoist.start.ts'),
  route('oauth/todoist/callback', 'routes/oauth.todoist.callback.ts'),

  // Resource routes (no UI).
  route('api/auth/*', 'routes/api.auth.$.ts'),
  route('api/trpc/*', 'routes/api.trpc.$.ts'),
  route('healthz', 'routes/healthz.ts'),
] satisfies RouteConfig
