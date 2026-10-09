import { defineConfig } from '@hey-api/openapi-ts'

/**
 * Generates the Glassfrog v3 client from the vendored spec in `openapi/`.
 *
 * The spec is vendored rather than fetched at build time because the Glassfrog
 * v3 API is legacy: pinning it means upstream changes surface as a
 * reviewable diff (`yarn gen:glassfrog:fetch`) instead of a silent break.
 */
export default defineConfig({
  input: './openapi/glassfrog-v3.yaml',
  output: {
    path: './server/glassfrog/generated-v3',
    // Formatting the output keeps regeneration diffs readable. The tree is still
    // excluded from lint and from `prettier --write .` — this is the only thing that
    // touches it.
    format: 'prettier',
  },
  // Tree-shakable functions (listMyActions, getRole, …) rather than a class.
  plugins: ['@hey-api/client-fetch', '@hey-api/typescript', '@hey-api/sdk'],
})
