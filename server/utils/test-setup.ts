import { existsSync } from 'node:fs'

/**
 * Loads `.env` for tests. In CI the variables are already exported by the workflow,
 * so a missing file is not an error.
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

// Tests deliberately exercise failure paths, so real log output is just noise.
// Override with LOG_LEVEL=debug when diagnosing a test.
process.env.LOG_LEVEL = process.env.VITEST_LOG_LEVEL ?? 'silent'
process.env.NODE_ENV = 'test'

/**
 * Placeholder values for anything still unset.
 *
 * `server/utils/env.ts` validates at import and throws, so these have to exist before any
 * server module loads — but nothing should ever dial them. The database is PGlite, the
 * queues are substituted, and both APIs are answered by msw. If a test does manage to
 * connect to `localhost:1`, that is the bug, and failing to connect is how you find out.
 */
const defaults: Record<string, string> = {
  DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
  REDIS_URL: 'redis://127.0.0.1:1',
  BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters-long',
  BETTER_AUTH_URL: 'http://localhost:5173',
  TODOIST_CLIENT_ID: 'test-client-id',
  TODOIST_CLIENT_SECRET: 'test-client-secret',
  TODOIST_REDIRECT_URI: 'http://localhost:5173/oauth/todoist/callback',
}

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value
}
