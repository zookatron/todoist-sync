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

  /** 32 raw bytes, base64-encoded. Generate with: openssl rand -base64 32 */
  ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
    message: 'ENCRYPTION_KEY must be 32 bytes encoded as base64 (openssl rand -base64 32)',
  }),

  TODOIST_CLIENT_ID: z.string().min(1),
  TODOIST_CLIENT_SECRET: z.string().min(1),
  TODOIST_REDIRECT_URI: z.string().url(),

  /** Poll cadence for the scheduled sync job. */
  SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * How to treat Todoist projects under the root that have no Glassfrog counterpart.
   * `dry-run` only records intent in sync_log; `archive` archives them in Todoist.
   */
  PRUNE_MODE: z.enum(['dry-run', 'archive']).default('archive'),

  /** Set false after creating your account to close the instance to new signups. */
  ALLOW_SIGNUP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
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

  return result.data
}

export const env = parseEnv()
