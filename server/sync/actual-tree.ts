import { listActiveProjects, listArchivedProjects } from '../todoist/projects.js'

/** A live Todoist project somewhere under the mirror root. */
export type ActualProject = {
  todoistProjectId: string
  name: string
  parentId: string | null
  updatedAt: Date | null
}

/** An archived Todoist project. Its position in the tree is gone; only identity remains. */
export type ArchivedProject = {
  name: string
  updatedAt: Date | null
}

export type ActualTree = {
  /**
   * Live projects beneath the root, at any depth.
   *
   * Scoped to the root because this is where *unmapped* projects are discovered, and the
   * user's unrelated personal projects must never be mistaken for part of the mirror.
   */
  live: ActualProject[]
  /**
   * Every live project by id, **including ones outside the root**.
   *
   * Already-mapped projects are looked up here rather than in `live`, because a mapped
   * project can legitimately be found outside the mirrored subtree: unarchiving in Todoist
   * does not restore `parent_id`, so a project the user brings back reappears at the top
   * level. Searching only under the root would report it as deleted and rebuild a duplicate,
   * stranding the original.
   */
  liveById: Map<string, ActualProject>
  /**
   * Every archived project in the account, by id.
   *
   * A map rather than a tree because Todoist **clears `parent_id` when it archives**, so an
   * archived project cannot be reached by walking down from the root and can only be
   * recognised by id. It is also why this is the whole account rather than the mirrored
   * subtree: there is no longer any way to tell which subtree it used to belong to, so the
   * mapping table is the only thing that can claim it.
   */
  archived: Map<string, ArchivedProject>
}

/**
 * Lists every live Todoist project beneath `rootId`, at any depth.
 *
 * Todoist only exposes a parent pointer, so descendants are resolved by repeatedly expanding
 * the frontier rather than by a single query.
 */
export function descendantsOf(
  rootId: string,
  projects: { id: string; name: string; parentId: string | null; updatedAt: Date | null }[],
): ActualProject[] {
  const childrenByParent = new Map<string, typeof projects>()
  for (const project of projects) {
    if (!project.parentId) continue
    const siblings = childrenByParent.get(project.parentId) ?? []
    siblings.push(project)
    childrenByParent.set(project.parentId, siblings)
  }

  const collected: ActualProject[] = []
  const queue = [rootId]
  const seen = new Set<string>([rootId])

  while (queue.length > 0) {
    const parentId = queue.shift()
    if (!parentId) break

    for (const child of childrenByParent.get(parentId) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      collected.push({
        todoistProjectId: child.id,
        name: child.name,
        parentId: child.parentId,
        updatedAt: child.updatedAt,
      })
      queue.push(child.id)
    }
  }

  return collected
}

/**
 * Reads the Todoist side of the mirror.
 *
 * Two listings, not one. Archiving removes a project from `GET /projects` entirely, so
 * without `GET /projects/archived` an archive would be indistinguishable from a deletion —
 * and the two mean opposite things here: archived means the project is finished, deleted
 * means rebuild it.
 *
 * Archiving in Todoist cascades over the whole sub-tree, so each descendant appears in the
 * archived listing in its own right; nothing has to be inferred from the lost parent links.
 */
export async function readActualTree(userId: string, rootId: string): Promise<ActualTree> {
  const [active, archived] = await Promise.all([
    listActiveProjects(userId),
    listArchivedProjects(userId),
  ])

  const flat = active.map((project) => ({
    id: project.id,
    name: project.name,
    parentId: project.parentId,
    updatedAt: project.updatedAt,
  }))

  return {
    live: descendantsOf(rootId, flat),
    liveById: new Map(
      flat.map((project) => [
        project.id,
        {
          todoistProjectId: project.id,
          name: project.name,
          parentId: project.parentId,
          updatedAt: project.updatedAt,
        },
      ]),
    ),
    archived: new Map(
      archived.map((project) => [project.id, { name: project.name, updatedAt: project.updatedAt }]),
    ),
  }
}
