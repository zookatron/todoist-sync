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

  it('deletes the Glassfrog action when a linked Todoist task was deleted', () => {
    // Deletion is two-way by configuration, so removing the task removes the action.
    expect(resolve({ glassfrog: present(), todoist: absent, mapping: linked })).toEqual({
      type: 'delete-glassfrog',
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
