import { createHash } from 'node:crypto'

/**
 * Pure conflict resolution for a single task.
 *
 * Decides what should happen given what each side currently looks like and what we last
 * recorded — without performing any I/O, so every branch is directly testable.
 */

/** The synced field set, normalized so both sides are directly comparable. */
export type TaskSnapshot = {
  /** Glassfrog `description` ↔ Todoist `content`. */
  content: string
  /** Glassfrog `note` ↔ Todoist `description`. */
  description: string
  completed: boolean
  updatedAt: Date | null
}

export type SideState =
  | { present: true; snapshot: TaskSnapshot }
  /** Absent: never existed, deleted, or moved out of scope. */
  | { present: false }

export type MappingState = {
  /** Whether we have previously linked these two. */
  linked: boolean
  contentHash: string | null
}

/**
 * Where the Todoist task should live, against where it actually lives.
 *
 * Placement is one-way: the action's role and parent project decide the containing Todoist
 * project, so a task found anywhere else has drifted and gets put back. The case this
 * exists for is a task stranded in an archived project — the hierarchy pass recreates an
 * archived mirror project empty, leaving the tasks that were inside it behind, reachable
 * by id but invisible in the app and outside the mirrored tree.
 */
export type Placement = {
  /** The project the action maps to, or null when the mirror has not caught up. */
  expectedProjectId: string | null
  /** The project the task is actually in, or null when there is no task. */
  actualProjectId: string | null
}

export type ResolveInput = {
  glassfrog: SideState
  todoist: SideState
  mapping: MappingState
  placement?: Placement
}

export type SyncDecision =
  | { type: 'noop'; reason: 'nothing-to-sync' | 'already-converged' }
  | { type: 'create-todoist' }
  | { type: 'create-glassfrog' }
  /** Glassfrog is newer; overwrite the Todoist task. */
  | { type: 'update-todoist'; snapshot: TaskSnapshot }
  /** Todoist is newer; overwrite the Glassfrog action. */
  | { type: 'update-glassfrog'; snapshot: TaskSnapshot }
  /** The task is in the wrong project; rebuild it in the right one with this content. */
  | { type: 'recreate-todoist'; snapshot: TaskSnapshot }
  | { type: 'delete-todoist' }

/**
 * Stable fingerprint of the synced fields.
 *
 * This is the echo suppressor. Writing to either API bumps that record's `updated_at`,
 * so our own write comes back as a "change" on the next poll; if both sides hash to the
 * same value there is nothing left to do, regardless of timestamps.
 */
export function contentHash(snapshot: TaskSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        content: snapshot.content.trim(),
        description: snapshot.description.trim(),
        completed: snapshot.completed,
      }),
    )
    .digest('hex')
}

function timeOf(snapshot: TaskSnapshot): number {
  return snapshot.updatedAt?.getTime() ?? 0
}

/**
 * Whether the task sits outside the project its action maps to.
 *
 * An unknown project on either side is **not** a mismatch: the mirror may simply not have
 * created the destination yet, and guessing would move the task somewhere worse.
 */
function isMisplaced(placement: Placement | undefined): boolean {
  if (!placement?.expectedProjectId || !placement.actualProjectId) return false
  return placement.expectedProjectId !== placement.actualProjectId
}

/**
 * Chooses the action that converges one task.
 *
 * Existence is resolved first, then placement, then content. When both sides changed, the
 * more recently modified one wins; an exact tie resolves in Glassfrog's favour, since it is
 * the system of record for the organization.
 *
 * Placement is checked ahead of content because a misplaced task has to be rebuilt either
 * way, and the rebuild carries the winning content with it rather than discarding it.
 *
 * Deletion is deliberately **one-way** for the same reason: an action that disappears from
 * Glassfrog takes its Todoist task with it, but deleting the task in Todoist does not touch
 * the action — the task is re-created from it instead.
 */
export function resolve(input: ResolveInput): SyncDecision {
  const { glassfrog, todoist, mapping } = input

  if (!glassfrog.present && !todoist.present) {
    return { type: 'noop', reason: 'nothing-to-sync' }
  }

  if (glassfrog.present && !todoist.present) {
    // Either the action is new, or a previously linked task was deleted in Todoist.
    // Both resolve the same way: Glassfrog is the system of record, so a live action
    // must have a task, and a deleted one is rebuilt from the action.
    return { type: 'create-todoist' }
  }

  if (!glassfrog.present && todoist.present) {
    return mapping.linked ? { type: 'delete-todoist' } : { type: 'create-glassfrog' }
  }

  // Both present.
  if (!glassfrog.present || !todoist.present) {
    return { type: 'noop', reason: 'nothing-to-sync' }
  }

  const todoistIsNewer = timeOf(todoist.snapshot) > timeOf(glassfrog.snapshot)
  const winner = todoistIsNewer ? todoist.snapshot : glassfrog.snapshot

  if (isMisplaced(input.placement)) {
    return { type: 'recreate-todoist', snapshot: winner }
  }

  if (contentHash(glassfrog.snapshot) === contentHash(todoist.snapshot)) {
    return { type: 'noop', reason: 'already-converged' }
  }

  return todoistIsNewer
    ? { type: 'update-glassfrog', snapshot: winner }
    : { type: 'update-todoist', snapshot: winner }
}

/** Glassfrog statuses that mean the action is finished. */
export const GLASSFROG_COMPLETED_STATUS = 'completed'

/** Glassfrog statuses that mean the action should no longer exist in Todoist. */
export const GLASSFROG_DEAD_STATUSES = new Set(['cancelled', 'archived'])
