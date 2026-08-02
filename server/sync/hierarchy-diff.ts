/**
 * Pure hierarchy reconciliation.
 *
 * Takes the tree Glassfrog says should exist, the Todoist projects that actually exist
 * under the root, and the stored mappings between them — and returns the operations that
 * would make Todoist match. No I/O, so every branch is cheap to test.
 */

export type MappingKind = 'role' | 'project'

/** A node the mirror should contain, derived from Glassfrog. */
export type DesiredNode = {
  kind: MappingKind
  glassfrogId: string
  name: string
  /** Parent Glassfrog node, or null when the parent is the configured Todoist root. */
  parentGlassfrogId: string | null
}

/** A Todoist project that currently exists somewhere under the root. */
export type ActualProject = {
  todoistProjectId: string
  name: string
  parentId: string | null
}

/** A previously recorded correspondence between the two sides. */
export type ExistingMapping = {
  kind: MappingKind
  glassfrogId: string
  todoistProjectId: string
}

export type HierarchyOperation =
  | { type: 'create'; node: DesiredNode; depth: number }
  | { type: 'rename'; todoistProjectId: string; glassfrogId: string; from: string; to: string }
  | {
      type: 'move'
      todoistProjectId: string
      glassfrogId: string
      /** Resolved at apply time when the new parent is itself being created. */
      toParentGlassfrogId: string | null
    }
  | { type: 'orphan'; todoistProjectId: string; name: string }

export type DiffInput = {
  desired: DesiredNode[]
  actual: ActualProject[]
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

/**
 * Computes the operations that reconcile Todoist with Glassfrog.
 *
 * Returned in a safe application order: creates (shallowest first, so a parent exists
 * before its children), then renames, then moves (also shallowest first), then orphans.
 */
export function diffHierarchy(input: DiffInput): HierarchyOperation[] {
  const { desired, actual, mappings, rootTodoistProjectId } = input

  const desiredByGlassfrogId = new Map(desired.map((node) => [node.glassfrogId, node]))
  const actualById = new Map(actual.map((project) => [project.todoistProjectId, project]))
  const mappingByKey = new Map(mappings.map((m) => [keyOf(m.kind, m.glassfrogId), m]))

  /** Todoist ids that correspond to something Glassfrog still wants. */
  const claimed = new Set<string>()

  const creates: Extract<HierarchyOperation, { type: 'create' }>[] = []
  const renames: Extract<HierarchyOperation, { type: 'rename' }>[] = []
  const moves: (Extract<HierarchyOperation, { type: 'move' }> & { depth: number })[] = []

  for (const node of desired) {
    const depth = depthOf(node, desiredByGlassfrogId)
    const mapping = mappingByKey.get(keyOf(node.kind, node.glassfrogId))
    const existing = mapping ? actualById.get(mapping.todoistProjectId) : undefined

    // No mapping, or the mapped project has since been deleted in Todoist.
    if (!mapping || !existing) {
      creates.push({ type: 'create', node, depth })
      continue
    }

    claimed.add(existing.todoistProjectId)

    if (existing.name !== node.name) {
      renames.push({
        type: 'rename',
        todoistProjectId: existing.todoistProjectId,
        glassfrogId: node.glassfrogId,
        from: existing.name,
        to: node.name,
      })
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
        type: 'move',
        todoistProjectId: existing.todoistProjectId,
        glassfrogId: node.glassfrogId,
        toParentGlassfrogId: node.parentGlassfrogId,
        depth,
      })
    }
  }

  // Anything under the root that Glassfrog does not account for: a project the user
  // created by hand, or one whose Glassfrog node disappeared.
  const orphans = actual
    .filter((project) => !claimed.has(project.todoistProjectId))
    .map<HierarchyOperation>((project) => ({
      type: 'orphan',
      todoistProjectId: project.todoistProjectId,
      name: project.name,
    }))

  return [
    ...creates.sort((a, b) => a.depth - b.depth),
    ...renames,
    ...moves.sort((a, b) => a.depth - b.depth).map(({ depth: _depth, ...move }) => move),
    ...orphans,
  ]
}
