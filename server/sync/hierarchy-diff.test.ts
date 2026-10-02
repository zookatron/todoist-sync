import { describe, expect, it } from 'vitest'
import {
  type ActualProject,
  type DesiredNode,
  diffHierarchy,
  type ExistingMapping,
} from './hierarchy-diff.js'

const ROOT = 'todoist-root'

const EARLY = new Date('2026-01-01T00:00:00Z')
const LATE = new Date('2026-06-01T00:00:00Z')

const role = (id: string, name: string): DesiredNode => ({
  kind: 'role',
  glassfrogId: id,
  name,
  parentGlassfrogId: null,
  active: true,
  updatedAt: null,
})

const project = (
  id: string,
  name: string,
  parent: string | null,
  overrides: { active?: boolean; updatedAt?: Date | null } = {},
): DesiredNode => ({
  kind: 'project',
  glassfrogId: id,
  name,
  parentGlassfrogId: parent,
  active: overrides.active ?? true,
  updatedAt: overrides.updatedAt ?? EARLY,
})

const actual = (
  id: string,
  name: string,
  parentId: string | null,
  overrides: { updatedAt?: Date | null } = {},
): ActualProject => ({
  todoistProjectId: id,
  name,
  parentId,
  updatedAt: overrides.updatedAt ?? EARLY,
})

/**
 * An archived Todoist project.
 *
 * Deliberately not part of `actual`: Todoist clears `parent_id` on archive, so an archived
 * project has no place in the tree and is only ever found by id.
 */
const gone = (
  id: string,
  name: string,
  overrides: { updatedAt?: Date | null } = {},
): [string, { name: string; updatedAt: Date | null }] => [
  id,
  { name, updatedAt: overrides.updatedAt ?? EARLY },
]

const mapped = (
  kind: 'role' | 'project',
  glassfrogId: string,
  todoistProjectId: string,
): ExistingMapping => ({ kind, glassfrogId, todoistProjectId })

function diff(input: {
  desired?: DesiredNode[]
  actual?: ActualProject[]
  /** Live, but not under the root — where Todoist dumps an unarchived project. */
  liveOutsideRoot?: ActualProject[]
  archived?: [string, { name: string; updatedAt: Date | null }][]
  mappings?: ExistingMapping[]
}) {
  const actual = input.actual ?? []
  const outside = input.liveOutsideRoot ?? []

  return diffHierarchy({
    desired: input.desired ?? [],
    actual,
    // Everything live, wherever it sits — what mapped lookups go through.
    liveById: new Map([...actual, ...outside].map((p) => [p.todoistProjectId, p])),
    archived: new Map(input.archived ?? []),
    mappings: input.mappings ?? [],
    rootTodoistProjectId: ROOT,
  })
}

describe('diffHierarchy', () => {
  describe('Glassfrog → Todoist', () => {
    it('returns nothing when the two trees already match', () => {
      const operations = diff({
        desired: [role('role_1', 'Marketing')],
        actual: [actual('td_1', 'Marketing', ROOT)],
        mappings: [mapped('role', 'role_1', 'td_1')],
      })

      expect(operations).toEqual([])
    })

    it('creates a project for an unmapped role', () => {
      const operations = diff({ desired: [role('role_1', 'Marketing')] })

      expect(operations).toEqual([{ type: 'create-todoist', node: role('role_1', 'Marketing') }])
    })

    it('does not mirror an unmapped Glassfrog project that is already finished', () => {
      const operations = diff({
        desired: [
          role('role_1', 'Marketing'),
          project('proj_1', 'Done', 'role_1', { active: false }),
        ],
        actual: [actual('td_1', 'Marketing', ROOT)],
        mappings: [mapped('role', 'role_1', 'td_1')],
      })

      expect(operations).toEqual([])
    })

    it('recreates a mapped node whose Todoist project was deleted', () => {
      // The mapping row survives, but nothing exists under the root any more — and a
      // deletion in Todoist never propagates back to Glassfrog.
      const operations = diff({
        desired: [role('role_1', 'Marketing')],
        actual: [],
        mappings: [mapped('role', 'role_1', 'td_gone')],
      })

      expect(operations).toMatchObject([{ type: 'create-todoist' }])
    })

    it('renames in Todoist when the Glassfrog name is the newer one', () => {
      const operations = diff({
        desired: [project('proj_1', 'Growth Marketing', null, { updatedAt: LATE })],
        actual: [actual('td_1', 'Marketing', ROOT, { updatedAt: EARLY })],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations).toMatchObject([
        {
          type: 'rename-todoist',
          todoistProjectId: 'td_1',
          glassfrogId: 'proj_1',
          from: 'Marketing',
          to: 'Growth Marketing',
        },
      ])
    })

    it('moves a project that sits under the wrong parent', () => {
      const operations = diff({
        desired: [role('role_1', 'Marketing'), project('proj_1', 'Website', 'role_1')],
        actual: [
          actual('td_1', 'Marketing', ROOT),
          // Website is directly under the root, but belongs under Marketing.
          actual('td_2', 'Website', ROOT),
        ],
        mappings: [mapped('role', 'role_1', 'td_1'), mapped('project', 'proj_1', 'td_2')],
      })

      expect(operations).toEqual([
        {
          type: 'move-todoist',
          todoistProjectId: 'td_2',
          glassfrogId: 'proj_1',
          name: 'Website',
          toParentGlassfrogId: 'role_1',
        },
      ])
    })

    it('archives and unmaps a project whose Glassfrog node disappeared', () => {
      const operations = diff({
        desired: [],
        actual: [actual('td_1', 'Deleted Role', ROOT)],
        mappings: [mapped('role', 'role_gone', 'td_1')],
      })

      expect(operations).toEqual([
        { type: 'archive-todoist', todoistProjectId: 'td_1', name: 'Deleted Role' },
        { type: 'drop-mapping', todoistProjectId: 'td_1' },
      ])
    })

    it('archives the Todoist project when Glassfrog completed it more recently', () => {
      const operations = diff({
        desired: [project('proj_1', 'Website', null, { active: false, updatedAt: LATE })],
        actual: [actual('td_1', 'Website', ROOT, { updatedAt: EARLY })],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations).toEqual([
        { type: 'archive-todoist', todoistProjectId: 'td_1', name: 'Website' },
      ])
    })

    it('keeps the mapping when a completed project is archived, so a later unarchive reopens it', () => {
      const operations = diff({
        desired: [project('proj_1', 'Website', null, { active: false, updatedAt: LATE })],
        actual: [actual('td_1', 'Website', ROOT, { updatedAt: EARLY })],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations.some((op) => op.type === 'drop-mapping')).toBe(false)
    })

    it('unarchives the Todoist project when Glassfrog reopened it more recently', () => {
      const operations = diff({
        desired: [project('proj_1', 'Website', null, { updatedAt: LATE })],
        archived: [gone('td_1', 'Website', { updatedAt: EARLY })],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations).toEqual([
        {
          type: 'unarchive-todoist',
          todoistProjectId: 'td_1',
          name: 'Website',
          toParentGlassfrogId: null,
        },
      ])
    })
  })

  describe('Todoist → Glassfrog', () => {
    it('adopts a project created inside a mapped role', () => {
      const operations = diff({
        desired: [role('role_1', 'Marketing')],
        actual: [actual('td_1', 'Marketing', ROOT), actual('td_new', 'Rebrand', 'td_1')],
        mappings: [mapped('role', 'role_1', 'td_1')],
      })

      expect(operations).toEqual([
        {
          type: 'create-glassfrog',
          todoistProjectId: 'td_new',
          name: 'Rebrand',
          parentTodoistProjectId: 'td_1',
        },
      ])
    })

    it('adopts a project created inside a mapped project', () => {
      const operations = diff({
        desired: [role('role_1', 'Marketing'), project('proj_1', 'Website', 'role_1')],
        actual: [
          actual('td_1', 'Marketing', ROOT),
          actual('td_2', 'Website', 'td_1'),
          actual('td_new', 'Homepage', 'td_2'),
        ],
        mappings: [mapped('role', 'role_1', 'td_1'), mapped('project', 'proj_1', 'td_2')],
      })

      expect(operations).toMatchObject([
        { type: 'create-glassfrog', todoistProjectId: 'td_new', parentTodoistProjectId: 'td_2' },
      ])
    })

    it('adopts a chain of new projects outermost-first', () => {
      const operations = diff({
        desired: [role('role_1', 'Marketing')],
        actual: [
          actual('td_1', 'Marketing', ROOT),
          // Deliberately supplied deepest-first.
          actual('td_deep', 'Deep', 'td_mid'),
          actual('td_mid', 'Mid', 'td_1'),
        ],
        mappings: [mapped('role', 'role_1', 'td_1')],
      })

      expect(
        operations.map((op) => (op.type === 'create-glassfrog' ? op.todoistProjectId : op.type)),
      ).toEqual(['td_mid', 'td_deep'])
    })

    it('leaves a hand-made project directly under the root alone', () => {
      // Only a role can sit there, and roles come from Glassfrog — so there is nothing to
      // create and nothing to clean up.
      const operations = diff({
        desired: [role('role_1', 'Marketing')],
        actual: [actual('td_1', 'Marketing', ROOT), actual('td_manual', 'My side project', ROOT)],
        mappings: [mapped('role', 'role_1', 'td_1')],
      })

      expect(operations).toEqual([])
    })

    it('ignores an unmapped archived project', () => {
      const operations = diff({
        desired: [role('role_1', 'Marketing')],
        actual: [actual('td_1', 'Marketing', ROOT)],
        mappings: [mapped('role', 'role_1', 'td_1')],
      })

      expect(operations).toEqual([])
    })

    it('completes the Glassfrog project when its Todoist mirror is archived', () => {
      const operations = diff({
        desired: [project('proj_1', 'Website', null, { updatedAt: EARLY })],
        archived: [gone('td_1', 'Website', { updatedAt: LATE })],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations).toEqual([
        {
          type: 'complete-glassfrog',
          glassfrogId: 'proj_1',
          todoistProjectId: 'td_1',
          name: 'Website',
        },
      ])
    })

    it('unarchives a role project instead, since a role cannot be completed', () => {
      const operations = diff({
        desired: [role('role_1', 'Marketing')],
        archived: [gone('td_1', 'Marketing')],
        mappings: [mapped('role', 'role_1', 'td_1')],
      })

      expect(operations).toEqual([
        {
          type: 'unarchive-todoist',
          todoistProjectId: 'td_1',
          name: 'Marketing',
          toParentGlassfrogId: null,
        },
      ])
    })

    it('completes a whole archived sub-tree together', () => {
      // Todoist cascades an archive over the sub-tree, so each descendant turns up in the
      // archived listing in its own right — nothing has to be inferred from parent links,
      // which archiving has cleared anyway.
      const operations = diff({
        desired: [
          project('proj_1', 'Website', null, { updatedAt: EARLY }),
          project('proj_2', 'Homepage', 'proj_1', { updatedAt: EARLY }),
        ],
        archived: [
          gone('td_1', 'Website', { updatedAt: LATE }),
          gone('td_2', 'Homepage', { updatedAt: LATE }),
        ],
        mappings: [mapped('project', 'proj_1', 'td_1'), mapped('project', 'proj_2', 'td_2')],
      })

      expect(operations.map((op) => op.type)).toEqual(['complete-glassfrog', 'complete-glassfrog'])
    })

    it('does not rebuild an archived project as though it had been deleted', () => {
      // The regression the live API exposed: because archiving clears `parent_id`, an
      // archived project is unreachable from the root. Looked for in the tree it reads as
      // deleted, and the mirror recreates it instead of completing the Glassfrog project.
      const operations = diff({
        desired: [project('proj_1', 'Website', null, { updatedAt: EARLY })],
        actual: [],
        archived: [gone('td_1', 'Website', { updatedAt: LATE })],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations.map((op) => op.type)).toEqual(['complete-glassfrog'])
      expect(operations.some((op) => op.type === 'create-todoist')).toBe(false)
    })

    it('reopens a completed Glassfrog project when Todoist unarchives it', () => {
      const operations = diff({
        desired: [project('proj_1', 'Website', null, { active: false, updatedAt: EARLY })],
        actual: [actual('td_1', 'Website', ROOT, { updatedAt: LATE })],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations).toEqual([
        {
          type: 'reopen-glassfrog',
          glassfrogId: 'proj_1',
          todoistProjectId: 'td_1',
          name: 'Website',
        },
      ])
    })

    it('reopens and reinstates a project the user unarchived in Todoist', () => {
      // Todoist does not restore `parent_id` on unarchive, so the project reappears at the
      // top level, outside the mirrored subtree. Looked for only under the root it reads as
      // deleted — which dropped the mapping and stranded the project — so mapped lookups go
      // through the account-wide listing, and the same pass moves it back.
      const operations = diff({
        desired: [project('proj_1', 'Website', null, { active: false, updatedAt: EARLY })],
        actual: [],
        liveOutsideRoot: [actual('td_1', 'Website', null, { updatedAt: LATE })],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations.map((op) => op.type)).toEqual(['move-todoist', 'reopen-glassfrog'])
      expect(operations.some((op) => op.type === 'drop-mapping')).toBe(false)
      expect(operations.some((op) => op.type === 'create-todoist')).toBe(false)
    })

    it('moves a mapped project back when it has drifted outside the root', () => {
      const operations = diff({
        desired: [project('proj_1', 'Website', null, { updatedAt: EARLY })],
        actual: [],
        liveOutsideRoot: [actual('td_1', 'Website', null, { updatedAt: EARLY })],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations).toEqual([
        {
          type: 'move-todoist',
          todoistProjectId: 'td_1',
          glassfrogId: 'proj_1',
          name: 'Website',
          toParentGlassfrogId: null,
        },
      ])
    })

    it('leaves a completed pair alone once both sides agree', () => {
      const operations = diff({
        desired: [project('proj_1', 'Website', null, { active: false })],
        archived: [gone('td_1', 'Website')],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations).toEqual([])
    })

    it('renames in Glassfrog when the Todoist name is the newer one', () => {
      const operations = diff({
        desired: [project('proj_1', 'Website', null, { updatedAt: EARLY })],
        actual: [actual('td_1', 'Website rebuild', ROOT, { updatedAt: LATE })],
        mappings: [mapped('project', 'proj_1', 'td_1')],
      })

      expect(operations).toEqual([
        {
          type: 'rename-glassfrog',
          glassfrogId: 'proj_1',
          todoistProjectId: 'td_1',
          from: 'Website',
          to: 'Website rebuild',
        },
      ])
    })

    it('reverts a role rename regardless of timestamps, since roles have none', () => {
      const operations = diff({
        desired: [role('role_1', 'Marketing')],
        actual: [actual('td_1', 'Marketing (mine)', ROOT, { updatedAt: LATE })],
        mappings: [mapped('role', 'role_1', 'td_1')],
      })

      expect(operations).toMatchObject([{ type: 'rename-todoist', to: 'Marketing' }])
    })
  })

  describe('mapping housekeeping', () => {
    it('drops a mapping when both sides are gone', () => {
      // This is the case the old second `getProjects` pass existed to catch.
      const operations = diff({
        desired: [],
        actual: [],
        mappings: [mapped('project', 'proj_gone', 'td_gone')],
      })

      expect(operations).toEqual([{ type: 'drop-mapping', todoistProjectId: 'td_gone' }])
    })

    it('drops a mapping for a completed project whose Todoist copy was deleted', () => {
      const operations = diff({
        desired: [project('proj_1', 'Website', 'role_1', { active: false })],
        actual: [],
        mappings: [mapped('project', 'proj_1', 'td_gone')],
      })

      expect(operations).toEqual([{ type: 'drop-mapping', todoistProjectId: 'td_gone' }])
    })

    it('drops a mapping without archiving when the Todoist project is already archived', () => {
      const operations = diff({
        desired: [],
        archived: [gone('td_1', 'Orphan')],
        mappings: [mapped('project', 'proj_gone', 'td_1')],
      })

      expect(operations).toEqual([{ type: 'drop-mapping', todoistProjectId: 'td_1' }])
    })
  })

  describe('ordering and safety', () => {
    it('orders creates shallowest-first so parents exist before children', () => {
      // Deliberately supplied deepest-first.
      const operations = diff({
        desired: [
          project('proj_2', 'Sub-sub', 'proj_1'),
          project('proj_1', 'Sub', 'role_1'),
          role('role_1', 'Marketing'),
        ],
      })

      expect(
        operations.map((op) => (op.type === 'create-todoist' ? op.node.glassfrogId : op.type)),
      ).toEqual(['role_1', 'proj_1', 'proj_2'])
    })

    it('handles deep sub-project nesting', () => {
      const operations = diff({
        desired: [
          role('role_1', 'Marketing'),
          project('proj_1', 'Website', 'role_1'),
          project('proj_2', 'Homepage', 'proj_1'),
          project('proj_3', 'Hero copy', 'proj_2'),
        ],
      })

      expect(operations).toHaveLength(4)
      expect(operations.every((op) => op.type === 'create-todoist')).toBe(true)
    })

    it('applies adoptions, creates, moves, status changes then drops in that order', () => {
      const operations = diff({
        desired: [
          role('role_1', 'Marketing'),
          project('proj_1', 'Website', 'role_1'),
          project('proj_done', 'Finished', 'role_1', { active: false, updatedAt: EARLY }),
        ],
        actual: [
          actual('td_1', 'Marketing', ROOT),
          // Website is mapped but misplaced.
          actual('td_2', 'Website', ROOT),
          // Unmapped and live inside a mapped role: adopt it.
          actual('td_new', 'Rebrand', 'td_1'),
          // Mapped to a completed Glassfrog project but unarchived more recently: reopen it.
          actual('td_done', 'Finished', 'td_1', { updatedAt: LATE }),
          // Mapped to nothing Glassfrog knows about: archive and unmap.
          actual('td_stale', 'Stale', 'td_1'),
        ],
        mappings: [
          mapped('role', 'role_1', 'td_1'),
          mapped('project', 'proj_1', 'td_2'),
          mapped('project', 'proj_done', 'td_done'),
          mapped('project', 'proj_vanished', 'td_stale'),
        ],
      })

      expect(operations.map((op) => op.type)).toEqual([
        'create-glassfrog',
        'move-todoist',
        'reopen-glassfrog',
        'archive-todoist',
        'drop-mapping',
      ])
    })

    it('never treats the root project itself as an orphan', () => {
      // The root is not part of `actual`; callers pass only its descendants. This asserts
      // the contract holds when the root is absent.
      const operations = diff({ desired: [], actual: [], mappings: [] })

      expect(operations).toEqual([])
    })

    it('does not loop forever on a cyclic Glassfrog parent chain', () => {
      const operations = diff({
        desired: [project('a', 'A', 'b'), project('b', 'B', 'a')],
      })

      // Both still get created — just ordered last, since their depth is unknowable.
      expect(operations).toHaveLength(2)
      expect(operations.every((op) => op.type === 'create-todoist')).toBe(true)
    })

    it('does not loop forever on a cyclic Todoist parent chain', () => {
      const operations = diff({
        desired: [role('role_1', 'Marketing')],
        actual: [
          actual('td_1', 'Marketing', ROOT),
          actual('td_a', 'A', 'td_b'),
          actual('td_b', 'B', 'td_a'),
        ],
        mappings: [mapped('role', 'role_1', 'td_1')],
      })

      // Neither is reachable from a mapped ancestor, so neither is adopted.
      expect(operations).toEqual([])
    })
  })
})
