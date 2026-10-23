import { paginateAll } from '../glassfrog/client.js'
import type { Client } from '../glassfrog/generated/client/index.js'
import {
  listMyProjects,
  listMyRoles,
  listRoleProjects,
  listSubProjects,
} from '../glassfrog/generated/sdk.gen.js'
import type { Project, Role } from '../glassfrog/generated/types.gen.js'
import type { DesiredNode } from './hierarchy-diff.js'
import { isOwnedBy, pruneToOwned } from './ownership.js'

/** Statuses that mean a project is done with; they are not mirrored into Todoist. */
const INACTIVE_STATUSES = new Set(['completed', 'cancelled', 'archived'])

/** Todoist rejects names beyond 120 characters. */
const MAX_NAME_LENGTH = 120

export function toProjectName(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim() || 'Untitled'
  return trimmed.length <= MAX_NAME_LENGTH ? trimmed : `${trimmed.slice(0, MAX_NAME_LENGTH - 1)}…`
}

export function isActive(status: string): boolean {
  return !INACTIVE_STATUSES.has(status)
}

/**
 * Reads the Glassfrog side of the mirror: the roles the user personally fills, and the user's
 * individual-initiative projects, which sit directly under the root alongside the roles.
 *
 * Scope is deliberately `/me/roles` rather than the whole organization: Glassfrog has no
 * org-wide action listing, so a full-org mirror would cost one request per role on every
 * poll and produce hundreds of Todoist projects.
 *
 * This is a **faithful** read, not a filtered one: inactive projects are reported with
 * `active: false` rather than dropped. The distinction matters because the diff has to tell
 * "completed in Glassfrog" from "gone from Glassfrog" — the first means the Todoist mirror
 * should be archived (or, if the user archived it first, that the two agree), the second
 * means the mapping is dead. Dropping them here would collapse both into "absent".
 *
 * Sub-projects are followed recursively, guarded against cycles and runaway depth.
 */
export async function buildDesiredTree(
  client: Client,
  options: {
    maxDepth?: number
    /** The user's actor id. When given, the tree is narrowed to the user's own projects. */
    actorId?: string
  } = {},
): Promise<DesiredNode[]> {
  const maxDepth = options.maxDepth ?? 10

  const roles = await paginateAll<Role>(async ({ cursor, perPage }) => {
    const response = await listMyRoles({
      client,
      query: { cursor, per_page: perPage },
      throwOnError: true,
    })
    return response.data
  })

  const nodes: DesiredNode[] = roles.map((role) => ({
    kind: 'role',
    glassfrogId: role.id,
    name: toProjectName(role.name),
    parentGlassfrogId: null,
    // A role cannot be completed, so it is always active.
    active: true,
    // Roles carry no timestamps at all in v5, which is why their names stay one-way.
    updatedAt: null,
  }))

  const seen = new Map<string, Project>()

  for (const role of roles) {
    const projects = await paginateAll<Project>(async ({ cursor, perPage }) => {
      const response = await listRoleProjects({
        client,
        path: { role_id: role.id },
        query: { cursor, per_page: perPage },
        throwOnError: true,
      })
      return response.data
    })

    for (const project of projects) {
      collectProject(project, role.id, nodes, seen)
      await collectSubProjects(client, project, nodes, seen, 1, maxDepth)
    }
  }

  // Role listings leave individual initiatives out; they have a listing of their own, which
  // (like a role's) returns the whole tree, sub-projects included.
  const initiatives = await paginateAll<Project>(async ({ cursor, perPage }) => {
    const response = await listMyProjects({
      client,
      query: { cursor, per_page: perPage, individual_initiative: true },
      throwOnError: true,
    })
    return response.data
  })

  for (const project of initiatives) {
    collectProject(project, null, nodes, seen)
    await collectSubProjects(client, project, nodes, seen, 1, maxDepth)
  }

  const { actorId } = options
  if (!actorId) return nodes

  // Everything reachable was read faithfully; only now narrow to the user's own, so the
  // sub-project crawl still finds an owned child under someone else's parent.
  const owned = [...seen.values()].filter((project) => isOwnedBy(project, actorId))
  return pruneToOwned(nodes, new Set(owned.map((project) => project.id)))
}

/**
 * Records one project.
 *
 * Nesting comes from the project's own `parent_project_id`, with `fallbackParentId` used
 * only when it has none. That matters because `/roles/{role_id}/projects` returns the role's
 * **whole tree**, not just its top level — a sub-project listed there would otherwise be
 * attached straight to the role, and whether it was depended on the order the API happened
 * to return things in.
 *
 * A top-level individual initiative goes directly under the root (a null parent), whichever
 * listing it arrived in: it carries the role it was recorded against in `role_id`, but is not
 * that role's project.
 */
function collectProject(
  project: Project,
  fallbackParentId: string | null,
  nodes: DesiredNode[],
  seen: Map<string, Project>,
): boolean {
  // A project reachable by two paths, or a malformed cycle, must not be added twice.
  if (seen.has(project.id)) return false
  seen.set(project.id, project)

  nodes.push({
    kind: 'project',
    glassfrogId: project.id,
    name: toProjectName(project.description),
    parentGlassfrogId:
      project.parent_project_id ?? (project.individual_initiative ? null : fallbackParentId),
    active: isActive(project.status),
    updatedAt: project.updated_at ? new Date(project.updated_at) : null,
    ...(project.individual_initiative && {
      individualInitiative: { roleGlassfrogId: project.role_id ?? null },
    }),
  })

  return true
}

/**
 * Descends into a project's children.
 *
 * An inactive project is reported but never recursed into: its sub-tree is finished work,
 * and crawling it would cost a request per node for something the mirror will not build.
 */
async function collectSubProjects(
  client: Client,
  project: Project,
  nodes: DesiredNode[],
  seen: Map<string, Project>,
  depth: number,
  maxDepth: number,
): Promise<void> {
  // `has_sub_projects` lets us skip a request for the common leaf case.
  if (!isActive(project.status) || !project.has_sub_projects || depth >= maxDepth) return

  const children = await paginateAll<Project>(async ({ cursor, perPage }) => {
    const response = await listSubProjects({
      client,
      path: { id: project.id },
      query: { cursor, per_page: perPage },
      throwOnError: true,
    })
    return response.data
  })

  for (const child of children) {
    if (!collectProject(child, project.id, nodes, seen)) continue
    await collectSubProjects(client, child, nodes, seen, depth + 1, maxDepth)
  }
}
