import { tracedFetch } from '../utils/http-trace.js'
import { withRetry } from './client.js'
import type { Client } from './generated-v3/client/index.js'
import { createClient, createConfig } from './generated-v3/client/index.js'
import { getActions, getActionsById, getProjects, getProjectsById } from './generated-v3/sdk.gen.js'
import type { Action, Project } from './generated-v3/types.gen.js'

/**
 * The spec's `/api/v3` server is relative, and `app.glassfrog.com` answers v3 with a 302 to
 * this host, so go straight there.
 */
export const GLASSFROG_V3_BASE_URL = 'https://api.glassfrog.com/api/v3'

/**
 * Glassfrog v3 is the only API that says who owns an action or project (`links.person`);
 * v5 attributes everything to the role. It uses a separate key from v5.
 */
export function createGlassfrogV3Client(apiKey: string): Client {
  return createClient(
    createConfig({
      baseUrl: GLASSFROG_V3_BASE_URL,
      headers: { 'X-Auth-Token': apiKey },
      fetch: tracedFetch('glassfrog', () => globalThis.fetch),
    }),
  )
}

/**
 * v3 paginates by page number and reports no total, so a short page is the end. The cap
 * throws rather than truncating, for the same reason `paginateAll` does: a partial list
 * would read as "the rest are no longer mine" and delete Todoist tasks.
 */
async function pageAll<T>(
  fetchPage: (params: { page: number; perPage: number }) => Promise<T[]>,
  maxPages = 100,
): Promise<T[]> {
  const perPage = 100
  const collected: T[] = []

  for (let page = 1; page <= maxPages; page++) {
    const items = await withRetry(() => fetchPage({ page, perPage }))
    collected.push(...items)
    if (items.length < perPage) return collected
  }

  throw new Error('Hit Glassfrog v3 pagination limit, unable to retrieve all results')
}

export type V3Kind = 'action' | 'project'

/** v3 id → owning person id, or null for an item with no owner. */
export type V3Owners = Map<number, number | null>

type OwnedV3Item = { id?: number; links?: { person?: number | null } }

function collectOwners(items: OwnedV3Item[], into: V3Owners): void {
  for (const item of items) {
    if (item.id != null) into.set(item.id, item.links?.person ?? null)
  }
}

/**
 * Who owns every action or project the list endpoint returns. Completed and archived actions
 * are included (they may still be mapped); projects are limited to current, future and
 * waiting, so a finished one has to be asked for by id.
 */
export async function listOwners(client: Client, kind: V3Kind): Promise<V3Owners> {
  const owners: V3Owners = new Map()

  const items =
    kind === 'action'
      ? await pageAll<Action>(async ({ page, perPage }) => {
          const response = await getActions({
            client,
            query: { page, per_page: perPage, include: '', exclude_completed: false },
            throwOnError: true,
          })
          return response.data.actions ?? []
        })
      : await pageAll<Project>(async ({ page, perPage }) => {
          const response = await getProjects({
            client,
            // No `status` filter: the spec documents one, but the live API answers any value
            // with a 500. Without it only current, future and waiting projects come back;
            // `getOwner` covers the rest.
            query: { page, per_page: perPage, include: '' },
            throwOnError: true,
          })
          return response.data.projects ?? []
        })

  collectOwners(items, owners)
  return owners
}

/**
 * Who owns one action or project: a person id, or null for nobody. Also null when v3 does
 * not know the id (404), since an item v3 cannot see is not one we can show to be the user's.
 */
export async function getOwner(client: Client, kind: V3Kind, v3Id: number): Promise<number | null> {
  if (kind === 'action') {
    const result = await withRetry(() =>
      getActionsById({ client, path: { id: v3Id }, query: { include: '' } }),
    )
    return ownerFromResult(kind, v3Id, result, (data) => data.actions)
  }

  const result = await withRetry(() =>
    getProjectsById({ client, path: { id: v3Id }, query: { include: '' } }),
  )
  return ownerFromResult(kind, v3Id, result, (data) => data.projects)
}

function ownerFromResult<T>(
  kind: V3Kind,
  v3Id: number,
  result: { data?: T; error?: unknown; response?: Response },
  pick: (data: T) => OwnedV3Item[] | undefined,
): number | null {
  if (result.response?.status === 404) return null
  if (result.error !== undefined || !result.data) {
    const status = result.response?.status ?? 'no response'
    throw new Error(`Glassfrog v3 GET ${kind} ${v3Id} failed (${status})`)
  }

  const owners: V3Owners = new Map()
  collectOwners(pick(result.data) ?? [], owners)
  return owners.get(v3Id) ?? null
}

/** One cheap read to prove a key works, before it is stored. */
export async function verifyV3Key(client: Client): Promise<void> {
  await withRetry(() =>
    getActions({ client, query: { per_page: 1, include: '' }, throwOnError: true }),
  )
}
