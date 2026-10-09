import { describe, expect, it } from 'vitest'
import type { DesiredNode } from './hierarchy-diff.js'
import { pruneToOwned } from './ownership.js'

describe('pruneToOwned', () => {
  const node = (
    glassfrogId: string,
    parentGlassfrogId: string | null,
    kind: 'role' | 'project' = 'project',
  ): DesiredNode => ({
    kind,
    glassfrogId,
    name: glassfrogId,
    parentGlassfrogId,
    active: true,
    updatedAt: null,
  })

  const tree = [
    node('role', null, 'role'),
    node('theirs', 'role'),
    node('mine-child', 'theirs'),
    node('theirs-leaf', 'theirs'),
    node('mine', 'role'),
  ]

  it("drops other people's projects but keeps the chain above an owned one", () => {
    const kept = pruneToOwned(tree, new Set(['mine', 'mine-child'])).map((n) => n.glassfrogId)
    expect(kept).toEqual(['role', 'theirs', 'mine-child', 'mine'])
  })

  it('always keeps roles', () => {
    expect(pruneToOwned(tree, new Set()).map((n) => n.glassfrogId)).toEqual(['role'])
  })

  it('survives a parent cycle', () => {
    const cyclic = [node('a', 'b'), node('b', 'a')]
    expect(pruneToOwned(cyclic, new Set(['a'])).map((n) => n.glassfrogId)).toEqual(['a', 'b'])
  })
})
