// Must stay first: it populates process.env, and the imports below validate it on load.
import '../server/utils/load-env.js'

import { createServer } from 'node:http'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { db, pool } from '../server/db/index.js'
import * as authSchema from '../server/db/schema/auth.js'
import { env } from '../server/utils/env.js'
import { logger } from '../server/utils/logger.js'

const log = logger.child({ process: 'migrate' })

// `db` is typed as the driver-agnostic `Database` so tests can swap in a PGlite instance
// (see server/db/index.ts); this container only ever runs against the real pool, so it is
// always the node-postgres driver the migrator requires.
await migrate(db as NodePgDatabase<typeof authSchema>, { migrationsFolder: './drizzle' })
log.info('Migrations applied')

if (env.INITIAL_USER_EMAIL && env.INITIAL_USER_PASSWORD) {
  const email = env.INITIAL_USER_EMAIL.toLowerCase()
  const [existing] = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
    .limit(1)

  if (existing) {
    log.info({ email }, 'Initial user already exists, skipping')
  } else {
    // A dedicated instance rather than server/utils/auth.ts's shared `auth`: that one
    // disables sign-up once ALLOW_SIGNUP=false, but seeding from trusted CI/CD variables
    // is not public signup and must work even with signups closed.
    const seedAuth = betterAuth({
      database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 12 },
    })

    await seedAuth.api.signUpEmail({
      body: { name: env.INITIAL_USER_NAME, email, password: env.INITIAL_USER_PASSWORD },
    })
    log.info({ email }, 'Created initial user')
  }
}

await pool.end()

// Migrations and seeding are one-shot; `web` and `worker` depend_on this container's
// healthcheck to sequence their own startup, so it stays up serving it indefinitely
// rather than exiting (docker-compose only reads "healthy", not "exited(0)").
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
    return
  }
  res.writeHead(404).end()
})

server.listen(env.MIGRATE_HEALTH_PORT, () => {
  log.info({ port: env.MIGRATE_HEALTH_PORT }, 'Migrate container ready, idling')
})

function shutdown(signal: string): void {
  log.info({ signal }, 'Shutting down migrate container')
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
