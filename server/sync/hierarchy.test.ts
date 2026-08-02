import { describe, expect, it } from 'vitest'
import { isActive, toProjectName } from './desired-tree.js'
import { descendantsOf } from './hierarchy.js'

const p = (id: string, name: string, parentId: string | null) => ({ id, name, parentId })

describe('descendantsOf', () => {
  it('collects children at every depth', () => {
    const projects = [
      p('root', 'Root', null),
      p('a', 'A', 'root'),
      p('b', 'B', 'a'),
      p('c', 'C', 'b'),
    ]

    expect(descendantsOf('root', projects).map((x) => x.todoistProjectId)).toEqual(['a', 'b', 'c'])
  })

  it('excludes the root itself', () => {
    const projects = [p('root', 'Root', null), p('a', 'A', 'root')]

    expect(descendantsOf('root', projects).map((x) => x.todoistProjectId)).not.toContain('root')
  })

  it('ignores projects outside the root subtree', () => {
    // Personal projects elsewhere in Todoist must never be considered orphans.
    const projects = [
      p('root', 'Root', null),
      p('a', 'A', 'root'),
      p('other', 'Unrelated', null),
      p('other-child', 'Unrelated child', 'other'),
    ]

    expect(descendantsOf('root', projects).map((x) => x.todoistProjectId)).toEqual(['a'])
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
      { todoistProjectId: 'a', name: 'A', parentId: 'root' },
      { todoistProjectId: 'b', name: 'B', parentId: 'a' },
    ])
  })
})

describe('toProjectName', () => {
  it('trims surrounding whitespace', () => {
    expect(toProjectName('  Marketing  ')).toBe('Marketing')
  })

  it('falls back to a placeholder for empty or missing names', () => {
    expect(toProjectName('')).toBe('Untitled')
    expect(toProjectName('   ')).toBe('Untitled')
    expect(toProjectName(null)).toBe('Untitled')
    expect(toProjectName(undefined)).toBe('Untitled')
  })

  it('truncates to Todoist’s 120-character limit', () => {
    const name = toProjectName('x'.repeat(200))

    expect(name).toHaveLength(120)
    expect(name.endsWith('…')).toBe(true)
  })

  it('leaves a name at exactly the limit untouched', () => {
    expect(toProjectName('x'.repeat(120))).toBe('x'.repeat(120))
  })
})

describe('isActive', () => {
  it('mirrors only live Glassfrog projects', () => {
    expect(isActive('current')).toBe(true)
    expect(isActive('waiting')).toBe(true)
    expect(isActive('scheduled')).toBe(true)
    expect(isActive('someday')).toBe(true)

    expect(isActive('completed')).toBe(false)
    expect(isActive('cancelled')).toBe(false)
    expect(isActive('archived')).toBe(false)
  })
})
