import { existsSync } from 'node:fs'

/**
 * Loads `.env` for tests. In CI the variables are already exported by the workflow,
 * so a missing file is not an error.
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}
