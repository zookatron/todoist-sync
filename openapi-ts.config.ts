import { defineConfig } from '@hey-api/openapi-ts'

/**
 * Generates the Glassfrog client from the vendored spec in `openapi/`.
 *
 * The spec is vendored rather than fetched at build time because the Glassfrog
 * v5 API is explicitly beta: pinning it means upstream changes surface as a
 * reviewable diff (`npm run gen:glassfrog:fetch`) instead of a silent break.
 */
export default defineConfig({
  input: './openapi/glassfrog.json',
  output: {
    path: './server/glassfrog/generated',
    format: 'biome',
  },
  plugins: [
    '@hey-api/client-fetch',
    '@hey-api/typescript',
    {
      name: '@hey-api/sdk',
      asClass: false,
    },
  ],
})
