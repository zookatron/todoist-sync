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

export type ResolveInput = {
  glassfrog: SideState
  todoist: SideState
  mapping: MappingState
}

export type SyncDecision =
  | { type: 'noop'; reason: 'nothing-to-sync' | 'already-converged' }
  | { type: 'create-todoist' }
  | { type: 'create-glassfrog' }
  /** Glassfrog is newer; overwrite the Todoist task. */
  | { type: 'update-todoist'; snapshot: TaskSnapshot }
  /** Todoist is newer; overwrite the Glassfrog action. */
  | { type: 'update-glassfrog'; snapshot: TaskSnapshot }
  | { type: 'delete-todoist' }
  | { type: 'delete-glassfrog' }

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
 * Chooses the action that converges one task.
 *
 * Existence is resolved first, then content. When both sides changed, the more recently
 * modified one wins; an exact tie resolves in Glassfrog's favour, since it is the system
 * of record for the organization.
 */
export function resolve(input: ResolveInput): SyncDecision {
  const { glassfrog, todoist, mapping } = input

  if (!glassfrog.present && !todoist.present) {
    return { type: 'noop', reason: 'nothing-to-sync' }
  }

  if (glassfrog.present && !todoist.present) {
    // Previously linked, now gone from Todoist: the user deleted the task, and deletion
    // is two-way, so the Glassfrog action goes too.
    return mapping.linked ? { type: 'delete-glassfrog' } : { type: 'create-todoist' }
  }

  if (!glassfrog.present && todoist.present) {
    return mapping.linked ? { type: 'delete-todoist' } : { type: 'create-glassfrog' }
  }

  // Both present.
  if (!glassfrog.present || !todoist.present) {
    return { type: 'noop', reason: 'nothing-to-sync' }
  }

  if (contentHash(glassfrog.snapshot) === contentHash(todoist.snapshot)) {
    return { type: 'noop', reason: 'already-converged' }
  }

  return timeOf(todoist.snapshot) > timeOf(glassfrog.snapshot)
    ? { type: 'update-glassfrog', snapshot: todoist.snapshot }
    : { type: 'update-todoist', snapshot: glassfrog.snapshot }
}

/** Glassfrog statuses that mean the action is finished. */
export const GLASSFROG_COMPLETED_STATUS = 'completed'

/** Glassfrog statuses that mean the action should no longer exist in Todoist. */
export const GLASSFROG_DEAD_STATUSES = new Set(['cancelled', 'archived'])
