import { describe, expect, it } from 'vitest'
import { filterTodoistChanges, type TodoistItem } from './delta.js'

const item = (overrides: Partial<TodoistItem> & { id: string }): TodoistItem => ({
  projectId: 'proj_mapped',
  updatedAt: new Date('2026-08-01T10:00:00Z'),
  isDeleted: false,
  ...overrides,
})

function filter(input: { items: TodoistItem[]; mapped?: string[]; tracked?: string[] }) {
  return filterTodoistChanges({
    items: input.items,
    mappedProjectIds: new Set(input.mapped ?? ['proj_mapped']),
    trackedTaskIds: new Set(input.tracked ?? []),
  })
}

describe('filterTodoistChanges', () => {
  it('keeps a changed task inside the mirrored tree', () => {
    const changes = filter({ items: [item({ id: 'task_1' })] })

    expect(changes).toEqual([{ todoistTaskId: 'task_1', isDeleted: false }])
  })

  it('ignores tasks in unrelated projects', () => {
    // Todoist's sync returns every change in the account, including personal tasks
    // that have nothing to do with Glassfrog.
    const changes = filter({ items: [item({ id: 'task_1', projectId: 'proj_personal' })] })

    expect(changes).toEqual([])
  })

  it('keeps a deletion for a task we already track', () => {
    // A deleted item reports no useful project, so only the tracking set can save it.
    const changes = filter({
      items: [item({ id: 'task_1', projectId: 'proj_gone', isDeleted: true })],
      tracked: ['task_1'],
    })

    expect(changes).toEqual([{ todoistTaskId: 'task_1', isDeleted: true }])
  })

  it('ignores deletion of a task that was never ours', () => {
    const changes = filter({ items: [item({ id: 'task_x', isDeleted: true })] })

    expect(changes).toEqual([])
  })

  it('keeps a tracked task dragged out of the mirrored tree', () => {
    // Still ours to reconcile — the sync job decides what moving out means.
    const changes = filter({
      items: [item({ id: 'task_1', projectId: 'proj_elsewhere' })],
      tracked: ['task_1'],
    })

    expect(changes).toEqual([{ todoistTaskId: 'task_1', isDeleted: false }])
  })

  it('returns nothing for an empty delta', () => {
    expect(filter({ items: [] })).toEqual([])
  })

  it('handles a mix of relevant and irrelevant items', () => {
    const changes = filter({
      items: [
        item({ id: 'keep_1' }),
        item({ id: 'skip_1', projectId: 'proj_personal' }),
        item({ id: 'keep_2', projectId: 'proj_other_mapped' }),
      ],
      mapped: ['proj_mapped', 'proj_other_mapped'],
    })

    expect(changes.map((c) => c.todoistTaskId)).toEqual(['keep_1', 'keep_2'])
  })
})
