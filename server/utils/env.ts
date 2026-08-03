import { z } from 'zod'

/**
 * Environment schema. Parsed once at import time so a misconfigured deployment
 * fails immediately and loudly rather than at the first database or API call.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url(),

  TODOIST_CLIENT_ID: z.string().min(1),
  TODOIST_CLIENT_SECRET: z.string().min(1),
  TODOIST_REDIRECT_URI: z.string().url(),

  /** Poll cadence for the scheduled sync job. */
  SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  /** Set false after creating your account to close the instance to new signups. */
  ALLOW_SIGNUP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  /**
   * Optional one-time account seed, read only by the `migrate` container. Lets a fresh
   * deployment provision its single user from CI/CD variables without ever opening
   * public signup — set these instead of flipping ALLOW_SIGNUP to true.
   */
  INITIAL_USER_EMAIL: z.string().email().optional(),
  INITIAL_USER_PASSWORD: z.string().min(12).optional(),
  INITIAL_USER_NAME: z.string().min(1).default('Admin'),

  /** Health server port for the `migrate` container; unused by the web/worker processes. */
  MIGRATE_HEALTH_PORT: z.coerce.number().int().positive().default(3001),
})

export type Env = z.infer<typeof EnvSchema>

function parseEnv(): Env {
  const result = EnvSchema.safeParse(process.env)

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`)
  }

  if (result.data.INITIAL_USER_EMAIL && !result.data.INITIAL_USER_PASSWORD) {
    throw new Error('INITIAL_USER_PASSWORD is required when INITIAL_USER_EMAIL is set.')
  }
  if (result.data.INITIAL_USER_PASSWORD && !result.data.INITIAL_USER_EMAIL) {
    throw new Error('INITIAL_USER_EMAIL is required when INITIAL_USER_PASSWORD is set.')
  }

  return result.data
}

export const env = parseEnv()
