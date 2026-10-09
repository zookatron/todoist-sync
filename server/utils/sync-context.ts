import { AsyncLocalStorage } from 'node:async_hooks'

type SyncContext = {
  /** Outermost first: `['poll', 'hierarchy', 'create-todoist']`. */
  phases: string[]
  /** Identifying fields (user, job, task ids…) merged down from every enclosing scope. */
  fields: Record<string, unknown>
}

const storage = new AsyncLocalStorage<SyncContext>()

/** Marks errors with the phase that was running when they were first thrown. */
const PHASE = Symbol('syncPhase')

/**
 * Runs `fn` inside a named step of the sync process.
 *
 * Anything logged by the HTTP trace layer while `fn` runs carries the phase path, and an
 * error escaping `fn` is tagged with the innermost phase it passed through, so a bare
 * "HTTP 404" can be traced back to "poll > hierarchy > rename-glassfrog".
 */
export async function withPhase<T>(
  phase: string,
  fn: () => Promise<T>,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const parent = storage.getStore()
  const context: SyncContext = {
    phases: [...(parent?.phases ?? []), phase],
    fields: { ...parent?.fields, ...fields },
  }

  try {
    return await storage.run(context, fn)
  } catch (error) {
    if (error && typeof error === 'object' && !(PHASE in error)) {
      Object.defineProperty(error, PHASE, { value: context.phases.join(' > ') })
    }
    throw error
  }
}

/** The phase path and fields in effect right now, for attaching to a log line. */
export function currentSyncContext(): { phase?: string } & Record<string, unknown> {
  const context = storage.getStore()
  if (!context) return {}
  return { ...context.fields, phase: context.phases.join(' > ') }
}

/** The phase path an error was thrown in, if it passed through {@link withPhase}. */
export function phaseOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && PHASE in error) {
    const phase = (error as Record<symbol, unknown>)[PHASE]
    if (typeof phase === 'string') return phase
  }
  return undefined
}
