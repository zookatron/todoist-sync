import { describe, expect, it } from 'vitest'
import { contentHash, resolve, type SideState, type TaskSnapshot } from './resolve.js'

const snapshot = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  content: 'Write the report',
  description: '',
  completed: false,
  updatedAt: new Date('2026-08-01T10:00:00Z'),
  ...overrides,
})

const present = (overrides: Partial<TaskSnapshot> = {}): SideState => ({
  present: true,
  snapshot: snapshot(overrides),
})

const absent: SideState = { present: false }

const linked = { linked: true, contentHash: null }
const unlinked = { linked: false, contentHash: null }

describe('resolve — existence', () => {
  it('does nothing when neither side has the task', () => {
    expect(resolve({ glassfrog: absent, todoist: absent, mapping: unlinked })).toEqual({
      type: 'noop',
      reason: 'nothing-to-sync',
    })
  })

  it('creates a Todoist task for a new Glassfrog action', () => {
    expect(resolve({ glassfrog: present(), todoist: absent, mapping: unlinked })).toEqual({
      type: 'create-todoist',
    })
  })

  it('creates a Glassfrog action for a new Todoist task', () => {
    expect(resolve({ glassfrog: absent, todoist: present(), mapping: unlinked })).toEqual({
      type: 'create-glassfrog',
    })
  })

  it('re-creates the Todoist task when a linked one was deleted', () => {
    // Deleting in Todoist does not delete the action: Glassfrog is the system of record,
    // so the task comes back from the action's data.
    expect(resolve({ glassfrog: present(), todoist: absent, mapping: linked })).toEqual({
      type: 'create-todoist',
    })
  })

  it('deletes the Todoist task when a linked Glassfrog action disappeared', () => {
    expect(resolve({ glassfrog: absent, todoist: present(), mapping: linked })).toEqual({
      type: 'delete-todoist',
    })
  })
})

describe('resolve — content', () => {
  it('does nothing when both sides already agree', () => {
    // Identical content with different timestamps is the classic echo: our own write
    // bumped one side's updated_at.
    const result = resolve({
      glassfrog: present({ updatedAt: new Date('2026-08-01T10:00:00Z') }),
      todoist: present({ updatedAt: new Date('2026-08-01T12:00:00Z') }),
      mapping: linked,
    })

    expect(result).toEqual({ type: 'noop', reason: 'already-converged' })
  })

  it('writes Glassfrog to Todoist when Glassfrog is newer', () => {
    const result = resolve({
      glassfrog: present({
        content: 'Updated in Glassfrog',
        updatedAt: new Date('2026-08-01T12:00:00Z'),
      }),
      todoist: present({ content: 'Old text', updatedAt: new Date('2026-08-01T10:00:00Z') }),
      mapping: linked,
    })

    expect(result).toMatchObject({ type: 'update-todoist' })
    expect(result).toHaveProperty('snapshot.content', 'Updated in Glassfrog')
  })

  it('writes Todoist to Glassfrog when Todoist is newer', () => {
    const result = resolve({
      glassfrog: present({ content: 'Old text', updatedAt: new Date('2026-08-01T10:00:00Z') }),
      todoist: present({
        content: 'Updated in Todoist',
        updatedAt: new Date('2026-08-01T12:00:00Z'),
      }),
      mapping: linked,
    })

    expect(result).toMatchObject({ type: 'update-glassfrog' })
    expect(result).toHaveProperty('snapshot.content', 'Updated in Todoist')
  })

  it('resolves an exact timestamp tie in Glassfrog’s favour', () => {
    // Glassfrog is the system of record for the organization.
    const sameTime = new Date('2026-08-01T10:00:00Z')
    const result = resolve({
      glassfrog: present({ content: 'Glassfrog wins', updatedAt: sameTime }),
      todoist: present({ content: 'Todoist loses', updatedAt: sameTime }),
      mapping: linked,
    })

    expect(result).toMatchObject({ type: 'update-todoist' })
  })

  it('treats a missing timestamp as oldest', () => {
    const result = resolve({
      glassfrog: present({ content: 'Has a timestamp' }),
      todoist: present({ content: 'No timestamp', updatedAt: null }),
      mapping: linked,
    })

    expect(result).toMatchObject({ type: 'update-todoist' })
  })

  it('detects a completion difference', () => {
    const result = resolve({
      glassfrog: present({ completed: false, updatedAt: new Date('2026-08-01T10:00:00Z') }),
      todoist: present({ completed: true, updatedAt: new Date('2026-08-01T12:00:00Z') }),
      mapping: linked,
    })

    expect(result).toMatchObject({ type: 'update-glassfrog' })
    expect(result).toHaveProperty('snapshot.completed', true)
  })

  it('detects a description-only difference', () => {
    const result = resolve({
      glassfrog: present({
        description: 'Context note',
        updatedAt: new Date('2026-08-01T12:00:00Z'),
      }),
      todoist: present({ description: '', updatedAt: new Date('2026-08-01T10:00:00Z') }),
      mapping: linked,
    })

    expect(result).toMatchObject({ type: 'update-todoist' })
  })
})

describe('resolve — placement', () => {
  const misplaced = { expectedProjectId: 'td-role', actualProjectId: 'td-archived' }

  it('rebuilds a task that is not in the project its action maps to', () => {
    // The stranded-task case: archiving a Todoist project leaves its tasks behind, and
    // the hierarchy pass recreates the project empty. Content still agrees, so without a
    // placement check this resolves to `already-converged` and the task stays invisible.
    const result = resolve({
      glassfrog: present(),
      todoist: present(),
      mapping: linked,
      placement: misplaced,
    })

    expect(result).toMatchObject({ type: 'recreate-todoist' })
  })

  it('carries the newer side’s content into the rebuild', () => {
    const result = resolve({
      glassfrog: present({ content: 'Old text', updatedAt: new Date('2026-08-01T10:00:00Z') }),
      todoist: present({
        content: 'Edited before it was stranded',
        updatedAt: new Date('2026-08-01T12:00:00Z'),
      }),
      mapping: linked,
      placement: misplaced,
    })

    expect(result).toMatchObject({ type: 'recreate-todoist' })
    expect(result).toHaveProperty('snapshot.content', 'Edited before it was stranded')
  })

  it('leaves a correctly placed task to the normal content rules', () => {
    const result = resolve({
      glassfrog: present(),
      todoist: present(),
      mapping: linked,
      placement: { expectedProjectId: 'td-role', actualProjectId: 'td-role' },
    })

    expect(result).toEqual({ type: 'noop', reason: 'already-converged' })
  })

  it('does not move a task when the mirror has no destination for it yet', () => {
    // A null expected project means the hierarchy pass has not created the project;
    // acting on that would move the task somewhere worse than where it is.
    const result = resolve({
      glassfrog: present(),
      todoist: present(),
      mapping: linked,
      placement: { expectedProjectId: null, actualProjectId: 'td-somewhere' },
    })

    expect(result).toEqual({ type: 'noop', reason: 'already-converged' })
  })

  it('ignores placement when there is no task to place', () => {
    const result = resolve({
      glassfrog: present(),
      todoist: absent,
      mapping: linked,
      placement: { expectedProjectId: 'td-role', actualProjectId: null },
    })

    expect(result).toEqual({ type: 'create-todoist' })
  })

  it('still deletes a misplaced task whose action is gone', () => {
    // Existence outranks placement: there is no point relocating a task that is about to
    // be removed.
    const result = resolve({
      glassfrog: absent,
      todoist: present(),
      mapping: linked,
      placement: misplaced,
    })

    expect(result).toEqual({ type: 'delete-todoist' })
  })
})

describe('contentHash', () => {
  it('ignores timestamps, which differ by construction after any write', () => {
    expect(contentHash(snapshot({ updatedAt: new Date('2020-01-01') }))).toBe(
      contentHash(snapshot({ updatedAt: new Date('2026-01-01') })),
    )
  })

  it('ignores surrounding whitespace', () => {
    expect(contentHash(snapshot({ content: '  Write the report  ' }))).toBe(
      contentHash(snapshot({ content: 'Write the report' })),
    )
  })

  it('changes when any synced field changes', () => {
    const base = contentHash(snapshot())

    expect(contentHash(snapshot({ content: 'Different' }))).not.toBe(base)
    expect(contentHash(snapshot({ description: 'Different' }))).not.toBe(base)
    expect(contentHash(snapshot({ completed: true }))).not.toBe(base)
  })
})
