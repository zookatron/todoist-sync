import { describe, expect, it } from 'vitest'
import { diffGlassfrogActions } from './delta.js'

const action = (id: string, updatedAt: string) => ({ id, updated_at: updatedAt })
const mapping = (glassfrogActionId: string, updatedAt: string | null) => ({
  glassfrogActionId,
  glassfrogUpdatedAt: updatedAt ? new Date(updatedAt) : null,
})

describe('diffGlassfrogActions', () => {
  it('reports nothing when every action matches its recorded timestamp', () => {
    const changes = diffGlassfrogActions({
      actions: [action('act_1', '2026-08-01T10:00:00Z')],
      mappings: [mapping('act_1', '2026-08-01T10:00:00Z')],
    })

    expect(changes).toEqual([])
  })

  it('treats an unmapped action as changed', () => {
    const changes = diffGlassfrogActions({
      actions: [action('act_new', '2026-08-01T10:00:00Z')],
      mappings: [],
    })

    expect(changes).toEqual([{ type: 'changed', glassfrogActionId: 'act_new' }])
  })

  it('detects an action modified since the last poll', () => {
    const changes = diffGlassfrogActions({
      actions: [action('act_1', '2026-08-01T11:00:00Z')],
      mappings: [mapping('act_1', '2026-08-01T10:00:00Z')],
    })

    expect(changes).toEqual([{ type: 'changed', glassfrogActionId: 'act_1' }])
  })

  it('ignores a timestamp older than the one recorded', () => {
    // Our stored value includes our own writes, so a stale read must not re-trigger.
    const changes = diffGlassfrogActions({
      actions: [action('act_1', '2026-08-01T09:00:00Z')],
      mappings: [mapping('act_1', '2026-08-01T10:00:00Z')],
    })

    expect(changes).toEqual([])
  })

  it('reports a mapped action that vanished from the enumeration', () => {
    // Glassfrog has no deletion feed: absence is the only signal.
    const changes = diffGlassfrogActions({
      actions: [],
      mappings: [mapping('act_gone', '2026-08-01T10:00:00Z')],
    })

    expect(changes).toEqual([{ type: 'missing', glassfrogActionId: 'act_gone' }])
  })

  it('treats a mapping with no recorded timestamp as changed', () => {
    const changes = diffGlassfrogActions({
      actions: [action('act_1', '2026-08-01T10:00:00Z')],
      mappings: [mapping('act_1', null)],
    })

    expect(changes).toEqual([{ type: 'changed', glassfrogActionId: 'act_1' }])
  })

  it('treats an unparseable timestamp as changed rather than freezing the action', () => {
    const changes = diffGlassfrogActions({
      actions: [action('act_1', 'not-a-date')],
      mappings: [mapping('act_1', '2026-08-01T10:00:00Z')],
    })

    expect(changes).toEqual([{ type: 'changed', glassfrogActionId: 'act_1' }])
  })

  it('reports changed and missing actions together', () => {
    const changes = diffGlassfrogActions({
      actions: [action('act_1', '2026-08-01T11:00:00Z'), action('act_2', '2026-08-01T10:00:00Z')],
      mappings: [
        mapping('act_1', '2026-08-01T10:00:00Z'),
        mapping('act_2', '2026-08-01T10:00:00Z'),
        mapping('act_gone', '2026-08-01T10:00:00Z'),
      ],
    })

    expect(changes).toEqual([
      { type: 'changed', glassfrogActionId: 'act_1' },
      { type: 'missing', glassfrogActionId: 'act_gone' },
    ])
  })
})
