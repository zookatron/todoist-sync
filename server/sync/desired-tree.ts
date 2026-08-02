import { paginateAll } from '../glassfrog/client.js'
import type { Client } from '../glassfrog/generated/client/index.js'
import { listMyRoles, listRoleProjects, listSubProjects } from '../glassfrog/generated/sdk.gen.js'
import type { Project, Role } from '../glassfrog/generated/types.gen.js'
import type { DesiredNode } from './hierarchy-diff.js'

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
 * Builds the tree Todoist should mirror, from the roles the user personally fills.
 *
 * Scope is deliberately `/me/roles` rather than the whole organization: Glassfrog has no
 * org-wide action listing, so a full-org mirror would cost one request per role on every
 * poll and produce hundreds of Todoist projects.
 *
 * Sub-projects are followed recursively, guarded against cycles and runaway depth.
 */
export async function buildDesiredTree(
  client: Client,
  options: { maxDepth?: number } = {},
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
  }))

  const seen = new Set<string>()

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
      if (!isActive(project.status)) continue
      await collectProject(client, project, role.id, nodes, seen, 1, maxDepth)
    }
  }

  return nodes
}

async function collectProject(
  client: Client,
  project: Project,
  parentGlassfrogId: string,
  nodes: DesiredNode[],
  seen: Set<string>,
  depth: number,
  maxDepth: number,
): Promise<void> {
  // A project reachable by two paths, or a malformed cycle, must not be added twice.
  if (seen.has(project.id)) return
  seen.add(project.id)

  nodes.push({
    kind: 'project',
    glassfrogId: project.id,
    name: toProjectName(project.description),
    parentGlassfrogId,
  })

  // `has_sub_projects` lets us skip a request for the common leaf case.
  if (!project.has_sub_projects || depth >= maxDepth) return

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
    if (!isActive(child.status)) continue
    await collectProject(client, child, project.id, nodes, seen, depth + 1, maxDepth)
  }
}
