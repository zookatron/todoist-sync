import { db } from '@server/db/index.js'
import { connection } from '@server/queue/queues.js'
import { sql } from 'drizzle-orm'
import type { Route } from './+types/healthz'

/**
 * Liveness/readiness probe. Reports 200 only when both datastores answer, since the app
 * cannot sync without either.
 */
export async function loader(_: Route.LoaderArgs) {
  const checks: Record<string, 'ok' | 'error'> = {}

  try {
    await db.execute(sql`select 1`)
    checks.postgres = 'ok'
  } catch {
    checks.postgres = 'error'
  }

  try {
    await connection.ping()
    checks.redis = 'ok'
  } catch {
    checks.redis = 'error'
  }

  const healthy = Object.values(checks).every((status) => status === 'ok')

  return Response.json(
    { status: healthy ? 'ok' : 'degraded', checks },
    {
      status: healthy ? 200 : 503,
    },
  )
}
