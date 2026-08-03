import { existsSync } from 'node:fs'

/**
 * Loads `.env` into `process.env` for the worker process.
 *
 * A module of its own, imported before anything else in `worker/index.ts`, because ESM
 * evaluates every import before the importing module's body runs. `server/utils/env.ts`
 * validates at import time and throws, so a `loadEnvFile()` call in the entrypoint body
 * would execute long after the failure it is meant to prevent.
 *
 * The web server does not need this — Vite loads `.env` itself — but the worker runs
 * under plain `tsx`/`node`, which do not.
 *
 * A missing file is not an error: in Docker and CI the variables are already exported.
 * `loadEnvFile` leaves any variable that is already set alone, so a real environment
 * always beats a stale checked-out `.env`.
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}
