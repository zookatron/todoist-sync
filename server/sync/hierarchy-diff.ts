/**
 * Pure hierarchy reconciliation.
 *
 * Takes what Glassfrog says exists, what Todoist says exists, and the stored mappings
 * between them — and returns the operations that reconcile the two. No I/O, so every branch
 * is cheap to test.
 *
 * Unlike the task sync, this is not a one-directional mirror. Reading the table in
 * {@link diffHierarchy} is the fastest way to understand the whole policy; the rules it
 * encodes are:
 *
 * - **Roles** are Glassfrog's alone. They are never created, renamed or completed from
 *   Todoist; archiving a role's mirror is undone.
 * - **Projects** are two-way for creation, completion and naming. A project born under a
 *   role in Todoist is created in Glassfrog; archiving one completes it; unarchiving it
 *   reopens it.
 * - **Deletion** stays one-way. A deleted mirror project is rebuilt, never propagated.
 */

import type { ActualProject, ArchivedProject } from './actual-tree.js'

export type { ActualProject, ArchivedProject }

export type MappingKind = 'role' | 'project'

/** A node Glassfrog reports, whether or not it should be mirrored. */
export type DesiredNode = {
  kind: MappingKind
  glassfrogId: string
  name: string
  /** Parent Glassfrog node, or null when the parent is the configured Todoist root. */
  parentGlassfrogId: string | null
  /** False for a completed, cancelled or archived project. Roles are always active. */
  active: boolean
  /** Glassfrog's `updated_at`. Null for roles, which v5 does not timestamp. */
  updatedAt: Date | null
  /**
   * Set on an individual-initiative project, which has no role above it in the tree. Carries
   * the role it is recorded against, because Glassfrog needs one to create a project beneath
   * it — null for one that predates that being recorded.
   */
  individualInitiative?: { roleGlassfrogId: string | null }
}

/** A previously recorded correspondence between the two sides. */
export type ExistingMapping = {
  kind: MappingKind
  glassfrogId: string
  todoistProjectId: string
}

export type HierarchyOperation =
  | { type: 'create-todoist'; node: DesiredNode }
  /** Adopt a Todoist-born project into Glassfrog. */
  | {
      type: 'create-glassfrog'
      todoistProjectId: string
      name: string
      /** Resolved at apply time, because the parent may itself be adopted in this pass. */
      parentTodoistProjectId: string
    }
  | {
      type: 'rename-todoist'
      todoistProjectId: string
      glassfrogId: string
      from: string
      to: string
    }
  | {
      type: 'rename-glassfrog'
      glassfrogId: string
      todoistProjectId: string
      from: string
      to: string
    }
  | {
      type: 'move-todoist'
      todoistProjectId: string
      glassfrogId: string
      name: string
      /** Resolved at apply time when the new parent is itself being created. */
      toParentGlassfrogId: string | null
    }
  | { type: 'complete-glassfrog'; glassfrogId: string; todoistProjectId: string; name: string }
  | { type: 'reopen-glassfrog'; glassfrogId: string; todoistProjectId: string; name: string }
  | { type: 'archive-todoist'; todoistProjectId: string; name: string }
  /**
   * Bring an archived project back.
   *
   * Carries the destination because Todoist does not restore `parent_id` on unarchive — the
   * project reappears at the top level, outside the mirrored tree, so the applier has to put
   * it back. Null means directly under the configured root.
   */
  | {
      type: 'unarchive-todoist'
      todoistProjectId: string
      name: string
      toParentGlassfrogId: string | null
    }
  | { type: 'drop-mapping'; todoistProjectId: string }

export type DiffInput = {
  desired: DesiredNode[]
  /** Live projects beneath the root. Unmapped projects are only ever adopted from here. */
  actual: ActualProject[]
  /**
   * Every live project by id, the root's subtree or not. Mapped projects are resolved through
   * this, so one that has drifted outside the mirror is moved back rather than rebuilt.
   */
  liveById: Map<string, ActualProject>
  /** Archived projects by id — see {@link ArchivedProject} for why this is not a tree. */
  archived: Map<string, ArchivedProject>
  mappings: ExistingMapping[]
  rootTodoistProjectId: string
}

const keyOf = (kind: MappingKind, glassfrogId: string) => `${kind}:${glassfrogId}`

/**
 * Distance from the root, used to order creates and moves parents-first.
 *
 * Returns `Infinity` for a node whose parent chain is broken or cyclic, which pushes it
 * to the end rather than crashing the sync.
 */
function depthOf(node: DesiredNode, byGlassfrogId: Map<string, DesiredNode>): number {
  let depth = 0
  let current = node
  const seen = new Set<string>([current.glassfrogId])

  while (current.parentGlassfrogId) {
    const parent = byGlassfrogId.get(current.parentGlassfrogId)
    if (!parent || seen.has(parent.glassfrogId)) return Number.POSITIVE_INFINITY

    seen.add(parent.glassfrogId)
    current = parent
    depth += 1
  }

  return depth
}

/** Same idea over the Todoist tree, for ordering adoptions parents-first. */
function todoistDepthOf(project: ActualProject, byId: Map<string, ActualProject>): number {
  let depth = 0
  let current = project
  const seen = new Set<string>([current.todoistProjectId])

  while (current.parentId) {
    const parent = byId.get(current.parentId)
    // Reaching the root, which is not itself in `actual`, is the normal exit.
    if (!parent) return depth
    if (seen.has(parent.todoistProjectId)) return Number.POSITIVE_INFINITY

    seen.add(parent.todoistProjectId)
    current = parent
    depth += 1
  }

  return depth
}

function timeOf(updatedAt: Date | null): number {
  return updatedAt?.getTime() ?? 0
}

/**
 * Reconciles a project that is open on one side and closed on the other.
 *
 * State alone cannot say which way to go: "completed in Glassfrog, still open in Todoist"
 * and "archived in Todoist, still current in Glassfrog" are each ambiguous between the two
 * sides having made opposite changes. So status resolves the same way names do — the side
 * with the newer `updated_at` wins, and writing to the loser makes the two agree, which
 * suppresses the echo on the next poll.
 *
 * A role is the exception: it cannot be completed at all, so Glassfrog always wins and the
 * mirror comes back.
 */
function resolveStatus(args: {
  node: DesiredNode
  todoistProjectId: string
  /** The Todoist side's timestamp, whichever listing it came from. */
  todoistUpdatedAt: Date | null
  todoistName: string
}): HierarchyOperation {
  const { node, todoistProjectId } = args

  const unarchive = {
    type: 'unarchive-todoist',
    todoistProjectId,
    name: node.name,
    toParentGlassfrogId: node.parentGlassfrogId,
  } satisfies HierarchyOperation

  // A role cannot be completed at all, so Glassfrog always wins and the mirror comes back.
  if (node.kind === 'role') return unarchive

  const todoistIsNewer = timeOf(args.todoistUpdatedAt) > timeOf(node.updatedAt)

  if (node.active) {
    // Archived in Todoist, current in Glassfrog.
    return todoistIsNewer
      ? {
          type: 'complete-glassfrog',
          glassfrogId: node.glassfrogId,
          todoistProjectId,
          name: node.name,
        }
      : unarchive
  }

  // Open in Todoist, completed in Glassfrog.
  return todoistIsNewer
    ? {
        type: 'reopen-glassfrog',
        glassfrogId: node.glassfrogId,
        todoistProjectId,
        name: node.name,
      }
    : { type: 'archive-todoist', todoistProjectId, name: args.todoistName }
}

/**
 * Whether an unmapped Todoist project has a mapped ancestor below the root.
 *
 * Adoption needs an owning Glassfrog role, which the applier finds by walking up to the
 * nearest mapped node. A project whose chain reaches the root without passing one has
 * nowhere to go: only roles and individual initiatives sit directly under the root, and a new
 * one has no role to be created through. Chains of several new projects are fine — the outermost is adopted first, and
 * by the time its children are applied it is mapped.
 */
function hasMappedAncestor(
  project: ActualProject,
  actualById: Map<string, ActualProject>,
  mappingByTodoistId: Map<string, ExistingMapping>,
  rootTodoistProjectId: string,
): boolean {
  let current = project
  const seen = new Set<string>([current.todoistProjectId])

  while (current.parentId && current.parentId !== rootTodoistProjectId) {
    if (mappingByTodoistId.has(current.parentId)) return true

    const parent = actualById.get(current.parentId)
    if (!parent || seen.has(parent.todoistProjectId)) return false

    seen.add(parent.todoistProjectId)
    current = parent
  }

  return false
}

/**
 * Computes the operations that reconcile the two project trees.
 *
 * Every mapped pair falls into exactly one row of this table:
 *
 * | Glassfrog node        | Todoist project       | Operation                          |
 * | --------------------- | --------------------- | ---------------------------------- |
 * | active                | present, not archived | rename / move as needed            |
 * | active, project       | present, archived     | newer side wins: `complete-glassfrog` or `unarchive-todoist` |
 * | active, role          | present, archived     | `unarchive-todoist`                |
 * | active                | absent                | `create-todoist` (rebuild)         |
 * | inactive              | present, archived     | nothing — both sides agree         |
 * | inactive, project     | present, not archived | newer side wins: `reopen-glassfrog` or `archive-todoist` |
 * | inactive              | absent                | `drop-mapping`                     |
 * | absent from Glassfrog | present, not archived | `archive-todoist` + `drop-mapping` |
 * | absent from Glassfrog | present, archived     | `drop-mapping`                     |
 * | absent from Glassfrog | absent                | `drop-mapping`                     |
 *
 * "Present, archived" is established by **id**, through the archived listing, not by position
 * in the tree: Todoist clears `parent_id` when it archives, so an archived project cannot be
 * reached by walking down from the root. Getting this wrong makes an archive look like a
 * deletion, and the mirror rebuilds the project instead of completing it.
 *
 * Status disagreement is settled by timestamp for the same reason names are: the state on
 * its own cannot say whether the user completed the project in Glassfrog or reopened it in
 * Todoist. A mapping row therefore survives completion as a tombstone, which is what makes
 * a later unarchive a reopen rather than a duplicate creation.
 *
 * An unmapped Glassfrog node is created in Todoist when active. An unmapped Todoist project
 * is adopted into Glassfrog when it is live and sits under a mapped role or project; one
 * directly under the root is left alone, because only roles and individual initiatives live
 * there and a new one has no role to be created through.
 *
 * Returned in a safe application order: adoptions and creates shallowest-first so a parent
 * exists before its children, then renames, moves, status changes, archives, and finally
 * mapping drops.
 */
export function diffHierarchy(input: DiffInput): HierarchyOperation[] {
  const { desired, actual, liveById, archived, mappings, rootTodoistProjectId } = input

  const desiredByGlassfrogId = new Map(desired.map((node) => [node.glassfrogId, node]))
  const actualById = new Map(actual.map((project) => [project.todoistProjectId, project]))
  const mappingByKey = new Map(mappings.map((m) => [keyOf(m.kind, m.glassfrogId), m]))
  const mappingByTodoistId = new Map(mappings.map((m) => [m.todoistProjectId, m]))

  const adoptions: { operation: HierarchyOperation; depth: number }[] = []
  const creates: { operation: HierarchyOperation; depth: number }[] = []
  const renames: HierarchyOperation[] = []
  const moves: { operation: HierarchyOperation; depth: number }[] = []
  const statusChanges: HierarchyOperation[] = []
  const archives: HierarchyOperation[] = []
  const drops: HierarchyOperation[] = []

  // ---- Glassfrog nodes, mapped or not -------------------------------------------------

  for (const node of desired) {
    const mapping = mappingByKey.get(keyOf(node.kind, node.glassfrogId))
    // Account-wide, not root-scoped: a mapped project that has drifted outside the mirror is
    // still ours, and belongs back inside it rather than being rebuilt.
    const existing = mapping ? liveById.get(mapping.todoistProjectId) : undefined

    if (!mapping) {
      // Unmapped: mirror it if Glassfrog still wants it, otherwise it is finished work
      // that predates the mirror and is none of our business.
      if (node.active) {
        creates.push({
          operation: { type: 'create-todoist', node },
          depth: depthOf(node, desiredByGlassfrogId),
        })
      }
      continue
    }

    const archivedCopy = archived.get(mapping.todoistProjectId)

    if (!existing && !archivedCopy) {
      // Mapped, but the Todoist project is in neither listing — deleted, not archived.
      // Deletion is one-way: rebuild it if Glassfrog still wants it, otherwise the mapping
      // is dead.
      if (node.active) {
        creates.push({
          operation: { type: 'create-todoist', node },
          depth: depthOf(node, desiredByGlassfrogId),
        })
      } else {
        drops.push({ type: 'drop-mapping', todoistProjectId: mapping.todoistProjectId })
      }
      continue
    }

    // Is the project open on both sides, or closed on both?
    if (node.active !== Boolean(existing)) {
      statusChanges.push(
        resolveStatus({
          node,
          todoistProjectId: mapping.todoistProjectId,
          todoistUpdatedAt: (existing ?? archivedCopy)?.updatedAt ?? null,
          todoistName: (existing ?? archivedCopy)?.name ?? node.name,
        }),
      )
    }

    // Everything below needs a live project to act on. An archived one is either converged
    // with a finished Glassfrog node or already handled above, and cannot be renamed or moved
    // in any case.
    if (!existing) continue

    // Both sides live. Reconcile name and placement.
    if (existing.name !== node.name) {
      // Names are two-way for projects, last writer winning; a role has no timestamp to
      // compare, so Glassfrog simply wins.
      const todoistIsNewer =
        node.kind === 'project' && timeOf(existing.updatedAt) > timeOf(node.updatedAt)

      renames.push(
        todoistIsNewer
          ? {
              type: 'rename-glassfrog',
              glassfrogId: node.glassfrogId,
              todoistProjectId: existing.todoistProjectId,
              from: node.name,
              to: existing.name,
            }
          : {
              type: 'rename-todoist',
              todoistProjectId: existing.todoistProjectId,
              glassfrogId: node.glassfrogId,
              from: existing.name,
              to: node.name,
            },
      )
    }

    // Where the project should sit: under its mapped parent, or under the root.
    const expectedParentId = node.parentGlassfrogId
      ? (mappingByKey.get(keyOf('project', node.parentGlassfrogId))?.todoistProjectId ??
        mappingByKey.get(keyOf('role', node.parentGlassfrogId))?.todoistProjectId)
      : rootTodoistProjectId

    // An undefined expected parent means the parent is being created in this same pass;
    // the move is still emitted and resolved at apply time.
    if (expectedParentId === undefined || existing.parentId !== expectedParentId) {
      moves.push({
        operation: {
          type: 'move-todoist',
          todoistProjectId: existing.todoistProjectId,
          glassfrogId: node.glassfrogId,
          name: node.name,
          toParentGlassfrogId: node.parentGlassfrogId,
        },
        depth: depthOf(node, desiredByGlassfrogId),
      })
    }
  }

  // ---- Mappings Glassfrog has forgotten ----------------------------------------------
  //
  // The loop above cannot see these: it iterates what Glassfrog reports, and the whole
  // point of these rows is that the node is not in there. A mapped project whose Glassfrog
  // node has vanished is a stale mirror, and a mapping pointing at nothing on either side
  // is simply garbage.

  const desiredKeys = new Set(desired.map((node) => keyOf(node.kind, node.glassfrogId)))

  for (const mapping of mappings) {
    // Keyed by kind as well, to match how the loop above looked the mapping up.
    if (desiredKeys.has(keyOf(mapping.kind, mapping.glassfrogId))) continue

    const existing = liveById.get(mapping.todoistProjectId)

    // Already archived, or gone outright: nothing to tidy, just forget it.
    if (existing) {
      archives.push({
        type: 'archive-todoist',
        todoistProjectId: existing.todoistProjectId,
        name: existing.name,
      })
    }

    drops.push({ type: 'drop-mapping', todoistProjectId: mapping.todoistProjectId })
  }

  // ---- Todoist projects nobody has claimed -------------------------------------------

  // `actual` holds only live projects, so an archived one the user owns — or one we archived
  // and have since unmapped — is never considered here.
  for (const project of actual) {
    if (mappingByTodoistId.has(project.todoistProjectId)) continue

    if (!hasMappedAncestor(project, actualById, mappingByTodoistId, rootTodoistProjectId)) continue

    adoptions.push({
      operation: {
        type: 'create-glassfrog',
        todoistProjectId: project.todoistProjectId,
        name: project.name,
        // Non-null: `hasMappedAncestor` is false for anything without a parent.
        parentTodoistProjectId: project.parentId ?? rootTodoistProjectId,
      },
      depth: todoistDepthOf(project, actualById),
    })
  }

  const byDepth = (a: { depth: number }, b: { depth: number }) => a.depth - b.depth

  return [
    ...adoptions.sort(byDepth).map((entry) => entry.operation),
    ...creates.sort(byDepth).map((entry) => entry.operation),
    ...renames,
    ...moves.sort(byDepth).map((entry) => entry.operation),
    ...statusChanges,
    ...archives,
    ...drops,
  ]
}
