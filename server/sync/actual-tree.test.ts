import { describe, expect, it } from 'vitest'
import { descendantsOf } from './actual-tree.js'

const p = (
  id: string,
  name: string,
  parentId: string | null,
  overrides: { updatedAt?: Date | null } = {},
) => ({ id, name, parentId, updatedAt: overrides.updatedAt ?? null })

const ids = (projects: { todoistProjectId: string }[]) =>
  projects.map((project) => project.todoistProjectId)

/**
 * `descendantsOf` walks **live** projects only.
 *
 * Archived ones cannot be placed in a tree at all — Todoist clears `parent_id` when it
 * archives — so they are carried separately, by id, and never reach this function.
 */
describe('descendantsOf', () => {
  it('collects children at every depth', () => {
    const projects = [
      p('root', 'Root', null),
      p('a', 'A', 'root'),
      p('b', 'B', 'a'),
      p('c', 'C', 'b'),
    ]

    expect(ids(descendantsOf('root', projects))).toEqual(['a', 'b', 'c'])
  })

  it('excludes the root itself', () => {
    const projects = [p('root', 'Root', null), p('a', 'A', 'root')]

    expect(ids(descendantsOf('root', projects))).not.toContain('root')
  })

  it('ignores projects outside the root subtree', () => {
    // Personal projects elsewhere in Todoist must never be considered orphans.
    const projects = [
      p('root', 'Root', null),
      p('a', 'A', 'root'),
      p('other', 'Unrelated', null),
      p('other-child', 'Unrelated child', 'other'),
    ]

    expect(ids(descendantsOf('root', projects))).toEqual(['a'])
  })

  it('returns nothing when the root has no children', () => {
    expect(descendantsOf('root', [p('root', 'Root', null)])).toEqual([])
  })

  it('does not loop on a cyclic parent chain', () => {
    // Todoist should never produce this, but a cycle must not hang the poller.
    const projects = [p('root', 'Root', null), p('a', 'A', 'b'), p('b', 'B', 'a')]

    expect(descendantsOf('root', projects)).toEqual([])
  })

  it('preserves the parent pointer so the diff can detect moves', () => {
    const projects = [p('root', 'Root', null), p('a', 'A', 'root'), p('b', 'B', 'a')]

    expect(descendantsOf('root', projects)).toEqual([
      { todoistProjectId: 'a', name: 'A', parentId: 'root', updatedAt: null },
      { todoistProjectId: 'b', name: 'B', parentId: 'a', updatedAt: null },
    ])
  })

  it('records the update timestamp the status and name rules compare', () => {
    const updatedAt = new Date('2026-06-01T00:00:00Z')
    const projects = [p('root', 'Root', null), p('a', 'A', 'root', { updatedAt })]

    expect(descendantsOf('root', projects)[0]?.updatedAt).toEqual(updatedAt)
  })

  it('drops a sub-tree whose parent has gone, rather than re-rooting it', () => {
    // What archiving a parent looks like in the live listing: the parent is absent and the
    // child's `parent_id` has been cleared, so neither is reachable. The archived listing is
    // what recognises them; this function must not guess.
    const projects = [p('root', 'Root', null), p('orphaned-child', 'Child', null)]

    expect(descendantsOf('root', projects)).toEqual([])
  })
})
