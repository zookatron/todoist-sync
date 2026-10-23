import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { glassfrogIntegration } from '../db/schema/integrations.js'
import type { Client } from '../glassfrog/generated/client/index.js'
import { getMe } from '../glassfrog/generated/sdk.gen.js'
import { logger } from '../utils/logger.js'
import type { DesiredNode } from './hierarchy-diff.js'

/**
 * Deciding which Glassfrog actions and projects are the API-key user's.
 *
 * Glassfrog attributes actions and projects to a *role*, so everything a co-filler adds to a
 * shared role shows up in `/me/actions` and `/roles/{id}/projects`. Each item also carries
 * `actor_id` — the person whose focus it is, or the owner of an individual initiative — and an
 * item is the user's when that is the user's own actor id. Null (nobody recorded, or the person
 * was removed) is nobody's.
 */

/** What ownership needs of an action or project. */
export type OwnershipCandidate = { actor_id?: string | null }

export function isOwnedBy(item: OwnershipCandidate, actorId: string): boolean {
  return item.actor_id === actorId
}

/**
 * The user's v5 actor id (`per_…`).
 *
 * Captured when the key is saved; a row saved before that existed has none, so it is read from
 * `/me` once and stored.
 */
export async function getActorId(userId: string, client: Client): Promise<string> {
  const integration = await db.query.glassfrogIntegration.findFirst({
    where: eq(glassfrogIntegration.userId, userId),
  })
  if (integration?.actorId) return integration.actorId

  const me = await getMe({ client, throwOnError: true })
  const actorId = me.data.data.actor.id

  await db
    .update(glassfrogIntegration)
    .set({ actorId, updatedAt: new Date() })
    .where(eq(glassfrogIntegration.userId, userId))

  logger.info({ userId, actorId }, 'Recorded Glassfrog actor id')
  return actorId
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
