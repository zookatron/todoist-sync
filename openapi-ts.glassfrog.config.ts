import { defineConfig } from '@hey-api/openapi-ts'

/**
 * Endpoints that accept `include_legacy_id` but whose vendored spec omits it. The API honours
 * the param on every standard list and show endpoint (see its "Legacy IDs" section); the spec
 * documents it for roles, actors and `/me` only.
 */
const LEGACY_ID_OPERATIONS = [
  ['/me/actions', 'Action'],
  ['/me/projects', 'Project'],
  ['/actions/{id}', 'Action'],
  ['/roles/{role_id}/actions', 'Action'],
  ['/projects/{project_id}/actions', 'Action'],
  ['/projects/{id}', 'Project'],
  ['/projects/{id}/sub_projects', 'Project'],
  ['/roles/{role_id}/projects', 'Project'],
] as const

const LEGACY_ID_PARAMETER = '#/components/parameters/IncludeLegacyId'

type SchemaWithProperties = { properties?: Record<string, unknown> }

/**
 * The slice of the spec the patch touches. The hook is typed as a union of OpenAPI 2.0, 3.0
 * and 3.1 documents, and 2.0 has no `components`; the vendored spec is 3.x.
 */
type PatchableSpec = {
  components?: { schemas?: Record<string, SchemaWithProperties | undefined> }
  paths?: Record<string, { get?: { parameters?: Array<{ $ref?: string }> } } | undefined>
}

/**
 * Generates the Glassfrog client from the vendored spec in `openapi/`.
 *
 * The spec is vendored rather than fetched at build time because the Glassfrog
 * v5 API is explicitly beta: pinning it means upstream changes surface as a
 * reviewable diff (`yarn gen:glassfrog:fetch`) instead of a silent break.
 */
export default defineConfig({
  input: './openapi/glassfrog.json',
  output: {
    path: './server/glassfrog/generated',
    // Formatting the output keeps regeneration diffs readable. The tree is still
    // excluded from lint and from `prettier --write .` — this is the only thing that
    // touches it.
    format: 'prettier',
  },
  parser: {
    patch: {
      // Patched at generation time so the generated types stay the single description of
      // what the API returns. Drop this when the spec documents `legacy_id` on these
      // endpoints, or when v3 (and with it `legacy_id`) retires.
      input: (rawSpec) => {
        const spec = rawSpec as unknown as PatchableSpec
        const schemas = spec.components?.schemas
        const roleLegacyId = schemas?.Role?.properties?.legacy_id
        if (!roleLegacyId) throw new Error('Glassfrog spec has no Role.legacy_id to copy')

        for (const [path, schemaName] of LEGACY_ID_OPERATIONS) {
          const operation = spec.paths?.[path]?.get
          if (!operation) throw new Error(`Glassfrog spec has no GET ${path} to patch`)

          operation.parameters ??= []
          const alreadyThere = operation.parameters.some(
            (parameter) => parameter.$ref === LEGACY_ID_PARAMETER,
          )
          if (!alreadyThere) operation.parameters.push({ $ref: LEGACY_ID_PARAMETER })

          const schema = schemas?.[schemaName]
          if (!schema?.properties) throw new Error(`Glassfrog spec has no ${schemaName} schema`)
          schema.properties.legacy_id ??= {
            ...(roleLegacyId as object),
            description: `**Transition-only.** The ${schemaName.toLowerCase()}'s v3 sequential integer id, present ONLY when \`?include_legacy_id=true\` is passed. Retires when the v3 API retires.`,
          }
        }
      },
    },
  },
  // Tree-shakable functions (listMyActions, getRole, …) rather than a class.
  plugins: ['@hey-api/client-fetch', '@hey-api/typescript', '@hey-api/sdk'],
})
