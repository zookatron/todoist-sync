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
    // No `format` post-processor: the generated tree is excluded from Biome in
    // biome.json, and invoking Biome's prebuilt binary here fails on NixOS.
    path: './server/glassfrog/generated',
  },
  // Tree-shakable functions (listMyActions, getRole, …) rather than a class.
  plugins: ['@hey-api/client-fetch', '@hey-api/typescript', '@hey-api/sdk'],
})
