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
