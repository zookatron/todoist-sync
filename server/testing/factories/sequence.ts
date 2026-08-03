const counters = new Map<string, number>()

/**
 * Monotonic per-name counter backing factory defaults.
 *
 * Deterministic rather than random (no faker): a test that fails prints `role-2`, not a
 * different uuid on every run, and a reader can tell at a glance which entity a value
 * belongs to. Reset between tests by the {@link DatabaseSimulator}, so the first user in
 * every test is always `user-1`.
 */
export function nextSequence(name: string): number {
  const next = (counters.get(name) ?? 0) + 1
  counters.set(name, next)
  return next
}

export function resetSequences(): void {
  counters.clear()
}
