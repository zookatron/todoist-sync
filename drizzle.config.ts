import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    // Read directly rather than via server/env.ts: drizzle-kit runs as a CLI and
    // should not require the full application environment to be present.
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
})
