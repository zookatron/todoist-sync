import { describe, expect, it } from 'vitest'
import {
  type ActualProject,
  type DesiredNode,
  diffHierarchy,
  type ExistingMapping,
} from './hierarchy-diff.js'

const ROOT = 'todoist-root'

const role = (id: string, name: string): DesiredNode => ({
  kind: 'role',
  glassfrogId: id,
  name,
  parentGlassfrogId: null,
})

const project = (id: string, name: string, parent: string): DesiredNode => ({
  kind: 'project',
  glassfrogId: id,
  name,
  parentGlassfrogId: parent,
})

const actual = (id: string, name: string, parentId: string | null): ActualProject => ({
  todoistProjectId: id,
  name,
  parentId,
})

const mapped = (
  kind: 'role' | 'project',
  glassfrogId: string,
  todoistProjectId: string,
): ExistingMapping => ({ kind, glassfrogId, todoistProjectId })

function diff(input: {
  desired?: DesiredNode[]
  actual?: ActualProject[]
  mappings?: ExistingMapping[]
}) {
  return diffHierarchy({
    desired: input.desired ?? [],
    actual: input.actual ?? [],
    mappings: input.mappings ?? [],
    rootTodoistProjectId: ROOT,
  })
}

describe('diffHierarchy', () => {
  it('returns nothing when Todoist already matches Glassfrog', () => {
    const operations = diff({
      desired: [role('role_1', 'Marketing')],
      actual: [actual('td_1', 'Marketing', ROOT)],
      mappings: [mapped('role', 'role_1', 'td_1')],
    })

    expect(operations).toEqual([])
  })

  it('creates a project for an unmapped role', () => {
    const operations = diff({ desired: [role('role_1', 'Marketing')] })

    expect(operations).toEqual([{ type: 'create', node: role('role_1', 'Marketing'), depth: 0 }])
  })

  it('recreates a mapped node whose Todoist project was deleted', () => {
    // The mapping row survives, but nothing exists under the root any more.
    const operations = diff({
      desired: [role('role_1', 'Marketing')],
      actual: [],
      mappings: [mapped('role', 'role_1', 'td_gone')],
    })

    expect(operations).toMatchObject([{ type: 'create' }])
  })

  it('renames when the Glassfrog name changed', () => {
    const operations = diff({
      desired: [role('role_1', 'Growth Marketing')],
      actual: [actual('td_1', 'Marketing', ROOT)],
      mappings: [mapped('role', 'role_1', 'td_1')],
    })

    expect(operations).toEqual([
      {
        type: 'rename',
        todoistProjectId: 'td_1',
        glassfrogId: 'role_1',
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
        type: 'move',
        todoistProjectId: 'td_2',
        glassfrogId: 'proj_1',
        toParentGlassfrogId: 'role_1',
      },
    ])
  })

  it('archives a project the user created by hand under the root', () => {
    const operations = diff({
      desired: [role('role_1', 'Marketing')],
      actual: [actual('td_1', 'Marketing', ROOT), actual('td_manual', 'My side project', ROOT)],
      mappings: [mapped('role', 'role_1', 'td_1')],
    })

    expect(operations).toEqual([
      { type: 'orphan', todoistProjectId: 'td_manual', name: 'My side project' },
    ])
  })

  it('orphans a project whose Glassfrog node disappeared', () => {
    const operations = diff({
      desired: [],
      actual: [actual('td_1', 'Deleted Role', ROOT)],
      mappings: [mapped('role', 'role_gone', 'td_1')],
    })

    expect(operations).toEqual([{ type: 'orphan', todoistProjectId: 'td_1', name: 'Deleted Role' }])
  })

  it('orders creates shallowest-first so parents exist before children', () => {
    // Deliberately supplied deepest-first.
    const operations = diff({
      desired: [
        project('proj_2', 'Sub-sub', 'proj_1'),
        project('proj_1', 'Sub', 'role_1'),
        role('role_1', 'Marketing'),
      ],
    })

    expect(operations.map((op) => (op.type === 'create' ? op.node.glassfrogId : op.type))).toEqual([
      'role_1',
      'proj_1',
      'proj_2',
    ])
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
    expect(operations.map((op) => (op.type === 'create' ? op.depth : -1))).toEqual([0, 1, 2, 3])
  })

  it('emits creates before moves and orphans last', () => {
    const operations = diff({
      desired: [role('role_1', 'Marketing'), project('proj_1', 'Website', 'role_1')],
      actual: [actual('td_2', 'Website', ROOT), actual('td_manual', 'Manual', ROOT)],
      mappings: [mapped('project', 'proj_1', 'td_2')],
    })

    expect(operations.map((op) => op.type)).toEqual(['create', 'move', 'orphan'])
  })

  it('never treats the root project itself as an orphan', () => {
    // The root is not part of `actual`; callers pass only its descendants. This asserts
    // the contract holds when the root is absent.
    const operations = diff({ desired: [], actual: [], mappings: [] })

    expect(operations).toEqual([])
  })

  it('does not loop forever on a cyclic parent chain', () => {
    const cyclic: DesiredNode[] = [
      { kind: 'project', glassfrogId: 'a', name: 'A', parentGlassfrogId: 'b' },
      { kind: 'project', glassfrogId: 'b', name: 'B', parentGlassfrogId: 'a' },
    ]

    const operations = diff({ desired: cyclic })

    // Both still get created — just ordered last, since their depth is unknowable.
    expect(operations).toHaveLength(2)
    expect(operations.every((op) => op.type === 'create')).toBe(true)
  })
})
