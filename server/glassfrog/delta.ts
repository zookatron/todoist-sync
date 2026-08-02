/**
 * Glassfrog change detection.
 *
 * Glassfrog v5 has no `updated_since` filter and no org-wide action list, so there is
 * nothing to be incremental against: the only way to find changes is to enumerate the
 * user's actions and compare each `updated_at` with what we last recorded.
 *
 * Restricting scope to `/me/actions` is what keeps this affordable at a 60s cadence.
 */

export type GlassfrogActionSummary = {
  id: string
  updated_at: string
}

export type GlassfrogMappingSummary = {
  glassfrogActionId: string
  glassfrogUpdatedAt: Date | null
}

export type GlassfrogChange =
  /** New to us, or modified since we last looked. */
  | { type: 'changed'; glassfrogActionId: string }
  /** Tracked before, absent now: deleted, or moved out of the user's roles. */
  | { type: 'missing'; glassfrogActionId: string }

export type GlassfrogDiffInput = {
  actions: GlassfrogActionSummary[]
  mappings: GlassfrogMappingSummary[]
}

export function diffGlassfrogActions(input: GlassfrogDiffInput): GlassfrogChange[] {
  const { actions, mappings } = input

  const lastSeenById = new Map(mappings.map((m) => [m.glassfrogActionId, m.glassfrogUpdatedAt]))
  const presentIds = new Set(actions.map((action) => action.id))

  const changes: GlassfrogChange[] = []

  for (const action of actions) {
    if (!lastSeenById.has(action.id)) {
      changes.push({ type: 'changed', glassfrogActionId: action.id })
      continue
    }

    const lastSeen = lastSeenById.get(action.id)
    const updatedAt = new Date(action.updated_at)

    // An unparseable timestamp must not silently freeze an action out of syncing.
    if (Number.isNaN(updatedAt.getTime())) {
      changes.push({ type: 'changed', glassfrogActionId: action.id })
      continue
    }

    if (!lastSeen || updatedAt.getTime() > lastSeen.getTime()) {
      changes.push({ type: 'changed', glassfrogActionId: action.id })
    }
  }

  for (const mapping of mappings) {
    if (!presentIds.has(mapping.glassfrogActionId)) {
      changes.push({ type: 'missing', glassfrogActionId: mapping.glassfrogActionId })
    }
  }

  return changes
}
