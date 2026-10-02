import { describe, expect, it } from 'vitest'
import { descendantsOf } from './actual-tree.js'

const p = (
  id: string,
  name: string,
  parentId: string | null,
  overrides: { archived?: boolean; updatedAt?: Date | null } = {},
) => ({
  id,
  name,
  parentId,
  archived: overrides.archived ?? false,
  updatedAt: overrides.updatedAt ?? null,
})

const ids = (projects: { todoistProjectId: string }[]) =>
  projects.map((project) => project.todoistProjectId)

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
      { todoistProjectId: 'a', name: 'A', parentId: 'root', archived: false, updatedAt: null },
      { todoistProjectId: 'b', name: 'B', parentId: 'a', archived: false, updatedAt: null },
    ])
  })

  it('carries each project’s own archived flag', () => {
    const projects = [
      p('root', 'Root', null),
      p('a', 'A', 'root'),
      p('b', 'B', 'root', { archived: true }),
    ]

    expect(descendantsOf('root', projects).map((x) => [x.todoistProjectId, x.archived])).toEqual([
      ['a', false],
      ['b', true],
    ])
  })

  it('inherits archived down the chain from an archived ancestor', () => {
    // Todoist archives a parent's sub-projects with it, but this must hold either way:
    // a live-looking child of an archived parent is finished work, not a live project.
    const projects = [
      p('root', 'Root', null),
      p('a', 'A', 'root', { archived: true }),
      p('b', 'B', 'a'),
      p('c', 'C', 'b'),
    ]

    expect(descendantsOf('root', projects).map((x) => [x.todoistProjectId, x.archived])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
    ])
  })

  it('keeps an archived project reachable so it is not mistaken for a deletion', () => {
    // This is the whole reason archived projects are fetched at all: dropping them would
    // orphan the sub-tree below, and the diff would rebuild it empty.
    const projects = [
      p('root', 'Root', null),
      p('a', 'A', 'root', { archived: true }),
      p('b', 'B', 'a'),
    ]

    expect(ids(descendantsOf('root', projects))).toEqual(['a', 'b'])
  })

  it('records the update timestamp the status and name rules compare', () => {
    const updatedAt = new Date('2026-06-01T00:00:00Z')
    const projects = [p('root', 'Root', null), p('a', 'A', 'root', { updatedAt })]

    expect(descendantsOf('root', projects)[0]?.updatedAt).toEqual(updatedAt)
  })
})
