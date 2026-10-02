import {
  listActiveProjects,
  listArchivedProjects,
  type TodoistProject,
} from '../todoist/projects.js'

/** A Todoist project that currently exists somewhere under the mirror root. */
export type ActualProject = {
  todoistProjectId: string
  name: string
  parentId: string | null
  /** True when this project — or an ancestor between it and the root — is archived. */
  archived: boolean
  updatedAt: Date | null
}

/**
 * Lists every Todoist project that sits beneath `rootId`, at any depth, archived included.
 *
 * Todoist only exposes a parent pointer, so descendants are resolved by repeatedly
 * expanding the frontier rather than by a single query.
 *
 * The archived flag is inherited: a live project under an archived parent counts as
 * archived. That is what makes the reconciler independent of whether Todoist flags a
 * sub-project individually when its parent is archived — either way the whole sub-tree
 * reads as archived, and stays reachable from the root instead of dropping out of the walk
 * and being misread as deleted.
 */
export function descendantsOf(rootId: string, projects: TodoistProject[]): ActualProject[] {
  const childrenByParent = new Map<string, typeof projects>()
  for (const project of projects) {
    if (!project.parentId) continue
    const siblings = childrenByParent.get(project.parentId) ?? []
    siblings.push(project)
    childrenByParent.set(project.parentId, siblings)
  }

  const collected: ActualProject[] = []
  const queue: { id: string; archived: boolean }[] = [{ id: rootId, archived: false }]
  const seen = new Set<string>([rootId])

  while (queue.length > 0) {
    const parent = queue.shift()
    if (!parent) break

    for (const child of childrenByParent.get(parent.id) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)

      const archived = parent.archived || child.archived

      collected.push({
        todoistProjectId: child.id,
        name: child.name,
        parentId: child.parentId,
        archived,
        updatedAt: child.updatedAt,
      })
      queue.push({ id: child.id, archived })
    }
  }

  return collected
}

/**
 * Reads the Todoist side of the mirror.
 *
 * Two listings, not one: archiving a project removes it from `GET /projects` entirely, so
 * without `GET /projects/archived` an archive is indistinguishable from a deletion — and
 * the whole point of this pass is that an archive means "completed" while a deletion means
 * "rebuild it".
 */
export async function readActualTree(userId: string, rootId: string): Promise<ActualProject[]> {
  const [active, archived] = await Promise.all([
    listActiveProjects(userId),
    listArchivedProjects(userId),
  ])

  return descendantsOf(rootId, [...active, ...archived])
}
