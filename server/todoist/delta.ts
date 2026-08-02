/**
 * Todoist change detection.
 *
 * Unlike Glassfrog, Todoist supports genuine incremental sync: `/sync` with a
 * `sync_token` returns only what changed since the token was issued, deletions included
 * (`isDeleted: true`). One request per poll, no matter how many tasks exist.
 */

export type TodoistItem = {
  id: string
  projectId: string
  updatedAt: Date | null
  isDeleted: boolean
}

export type TodoistChange = {
  todoistTaskId: string
  isDeleted: boolean
}

export type FilterInput = {
  items: TodoistItem[]
  /** Todoist projects inside the mirrored tree; anything else is none of our business. */
  mappedProjectIds: Set<string>
  /** Task ids we already track, which stay in scope even after leaving the tree. */
  trackedTaskIds: Set<string>
}

/**
 * Narrows a sync response to the items this app should act on.
 *
 * Todoist returns every change in the account, so the user's unrelated personal tasks
 * have to be filtered out. Tasks we already track are kept regardless of project, so
 * that a task dragged *out* of the mirrored tree — or deleted, which reports no useful
 * project — is still reconciled.
 */
export function filterTodoistChanges(input: FilterInput): TodoistChange[] {
  const { items, mappedProjectIds, trackedTaskIds } = input

  return items
    .filter(
      (item) =>
        trackedTaskIds.has(item.id) || (!item.isDeleted && mappedProjectIds.has(item.projectId)),
    )
    .map((item) => ({ todoistTaskId: item.id, isDeleted: item.isDeleted }))
}
