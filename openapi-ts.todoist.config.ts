import { defineConfig } from '@hey-api/openapi-ts'

/**
 * Generates Todoist wire types from the vendored spec in `openapi/`.
 *
 * Types only — no client and no SDK. The application talks to Todoist through
 * `@doist/todoist-sdk`, which presents everything in camelCase; a second generated client
 * would be dead code. What is missing is a description of the **wire** format, and that is
 * what the test simulator needs in order to answer requests the way Todoist really does
 * (`ItemSyncView`, `PersonalProjectSyncView` and friends are all snake_case). Generating
 * them means the simulator cannot drift from the published contract without the compiler
 * noticing.
 *
 * The spec is vendored for the same reason as Glassfrog's: upstream changes should surface
 * as a reviewable diff (`yarn gen:todoist:fetch`) rather than a silent break. Note the
 * source is `developer.todoist.com`, not the API host — `api.todoist.com/api/v1/openapi.json`
 * requires authentication and answers 403.
 *
 * The Sync API (`POST /api/v1/sync`) is **not** in this spec. Types for those payloads come
 * from `@doist/todoist-sdk` itself.
 */
export default defineConfig({
  input: './openapi/todoist.json',
  output: {
    path: './server/todoist/generated',
    format: 'prettier',
  },
  plugins: ['@hey-api/typescript'],
})
