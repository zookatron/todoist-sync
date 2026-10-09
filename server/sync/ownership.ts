import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { glassfrogIntegration } from '../db/schema/integrations.js'
import type { Client } from '../glassfrog/generated-v3/client/index.js'
import { createGlassfrogV3Client, getOwner, listOwners, type V3Owners } from '../glassfrog/v3.js'
import { getConnection } from '../queue/queues.js'
import { logger } from '../utils/logger.js'
import type { DesiredNode } from './hierarchy-diff.js'

/**
 * Deciding which Glassfrog actions and projects are the API-key user's.
 *
 * Glassfrog v5 attributes actions and projects to a *role*, so everything a co-filler adds
 * to a shared role shows up in `/me/actions` and `/roles/{id}/projects`. Only v3 records a
 * person (`links.person`). v3 and v5 ids differ, but v5 returns each resource's v3 id as
 * `legacy_id` when asked (`include_legacy_id=true`), which is the join.
 *
 * Owners are cached in Redis, v5 id → v3 person id, and checked before anything else. An
 * entry is written once and then trusted for ten days: ownership rarely changes, and an item
 * is not re-checked after its first lookup. Nothing is cached in process.
 */

export type OwnedKind = 'action' | 'project'

/** What ownership needs of a v5 action or project. */
export type OwnershipCandidate = {
  id: string
  /** The item's v3 id. The list and show requests all ask for it. */
  legacy_id?: number | null
  role_id?: string | null
}

export type Ownership = {
  /** The ids, out of `items`, that are the user's. */
  ownedIds: (kind: OwnedKind, items: OwnershipCandidate[]) => Promise<Set<string>>
  /**
   * Records that the user owns a v5 item, for one they just created. Checked live, v3 already
   * attributes a new action to its creator, so this is a safety net against a lookup racing the
   * create (a wrong answer would be remembered for ten days) and saves that lookup.
   */
  recordOwned: (v5Id: string) => Promise<void>
}

/**
 * Drops projects that are not the user's from the desired tree, keeping any that still
 * have an owned descendant: a sub-project cannot be mirrored without its parent chain.
 * Roles are always kept — the user fills them.
 */
export function pruneToOwned(
  nodes: DesiredNode[],
  ownedProjectIds: ReadonlySet<string>,
): DesiredNode[] {
  const byId = new Map(nodes.map((node) => [node.glassfrogId, node]))
  const keep = new Set<string>()

  for (const id of ownedProjectIds) {
    let current = byId.get(id)
    // The visited guard stops a malformed parent cycle from looping.
    while (current && !keep.has(current.glassfrogId)) {
      keep.add(current.glassfrogId)
      current = current.parentGlassfrogId ? byId.get(current.parentGlassfrogId) : undefined
    }
  }

  return nodes.filter((node) => node.kind === 'role' || keep.has(node.glassfrogId))
}

// ── Owner cache (Redis) ─────────────────────────────────────────────────────

/** Ownership is assumed to rarely change; the TTL only stops Redis growing without bound. */
export const OWNER_TTL_SECONDS = 10 * 24 * 60 * 60

/** Stored for an item v3 says nobody owns, so that is not looked up again either. */
const NO_OWNER = 'none'

/**
 * Redis trouble must slow ownership checks down, never stall a sync: a command against an
 * unreachable server would otherwise queue forever (BullMQ needs `maxRetriesPerRequest: null`).
 */
const REDIS_TIMEOUT_MS = 2_000

export const ownerKey = (v5Id: string): string => `glassfrog:owner:${v5Id}`

/** v5 id → owning v3 person id, or null for an item with no owner. Absent = not cached. */
type CachedOwners = Map<string, number | null>

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Redis timed out')), REDIS_TIMEOUT_MS)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

async function readCachedOwners(v5Ids: string[]): Promise<CachedOwners> {
  const found: CachedOwners = new Map()
  if (v5Ids.length === 0) return found

  try {
    const values = await withTimeout(getConnection().mget(...v5Ids.map(ownerKey)))
    values.forEach((value, index) => {
      const id = v5Ids[index]
      if (id === undefined || value === null) return
      if (value === NO_OWNER) return void found.set(id, null)
      const person = Number(value)
      if (Number.isInteger(person)) found.set(id, person)
    })
  } catch (error) {
    logger.warn({ err: error }, 'Could not read cached Glassfrog owners; asking the API')
  }
  return found
}

async function writeCachedOwners(entries: Array<[string, number | null]>): Promise<void> {
  if (entries.length === 0) return

  try {
    const pipeline = getConnection().pipeline()
    for (const [v5Id, person] of entries) {
      pipeline.set(
        ownerKey(v5Id),
        person === null ? NO_OWNER : String(person),
        'EX',
        OWNER_TTL_SECONDS,
      )
    }
    await withTimeout(pipeline.exec())
  } catch (error) {
    logger.warn({ err: error }, 'Could not cache Glassfrog owners')
  }
}

// ── Resolving owners ────────────────────────────────────────────────────────

/**
 * Below this many uncached items, one v3 request each is cheaper than listing everything in
 * the organization; above it, paging the whole list is.
 */
const PER_ITEM_LOOKUP_LIMIT = 5

/** Thrown when the user has not (yet) saved the v3 key that ownership depends on. */
export class GlassfrogV3KeyRequiredError extends Error {
  constructor(userId: string) {
    super(`User ${userId} has not saved a Glassfrog v3 API key; sync is off until they do`)
    this.name = 'GlassfrogV3KeyRequiredError'
  }
}

/**
 * Asks v3 who owns each item.
 *
 * Few items are asked about one at a time; many are read from the organization-wide list, and
 * any the list does not cover (a finished project) are then asked about individually. An item
 * v3 does not know comes back as owned by nobody, so it is cached and not asked about again.
 */
async function lookupOwners(
  v3: Client,
  kind: OwnedKind,
  items: OwnershipCandidate[],
): Promise<Array<[string, number | null]>> {
  const withLegacy = items.filter(
    (item): item is OwnershipCandidate & { legacy_id: number } => item.legacy_id != null,
  )

  const listed: V3Owners | null =
    withLegacy.length > PER_ITEM_LOOKUP_LIMIT ? await listOwners(v3, kind) : null

  const found: Array<[string, number | null]> = []
  for (const item of withLegacy) {
    const known = listed?.get(item.legacy_id)
    found.push([item.id, known !== undefined ? known : await getOwner(v3, kind, item.legacy_id)])
  }
  return found
}

/**
 * The ownership test for a user.
 *
 * @throws GlassfrogV3KeyRequiredError if no v3 key is saved. There is deliberately no
 * fallback: without v3 there is no telling whose items are whose, and guessing from roles
 * would sync a co-filler's work.
 */
export async function getOwnership(userId: string): Promise<Ownership> {
  const integration = await db.query.glassfrogIntegration.findFirst({
    where: eq(glassfrogIntegration.userId, userId),
  })
  if (!integration?.v3ApiKey || integration.v3PersonId == null) {
    throw new GlassfrogV3KeyRequiredError(userId)
  }

  const v3 = createGlassfrogV3Client(integration.v3ApiKey)
  const personId = integration.v3PersonId

  return {
    ownedIds: async (kind, items) => {
      if (items.length === 0) return new Set()

      const owners = await readCachedOwners(items.map((item) => item.id))
      const uncached = items.filter((item) => !owners.has(item.id))

      if (uncached.length > 0) {
        const looked = await lookupOwners(v3, kind, uncached)
        await writeCachedOwners(looked)
        for (const [id, owner] of looked) owners.set(id, owner)
        logger.debug(
          { userId, kind, cached: items.length - uncached.length, looked: looked.length },
          'Resolved Glassfrog owners',
        )
      }

      return new Set(items.filter((item) => owners.get(item.id) === personId).map((i) => i.id))
    },

    recordOwned: (v5Id) => writeCachedOwners([[v5Id, personId]]),
  }
}
