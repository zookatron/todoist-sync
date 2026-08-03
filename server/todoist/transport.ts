import type { TodoistApiOptions } from '@doist/todoist-sdk'

/**
 * How the Todoist SDK reaches the network.
 *
 * Empty in production, which leaves the SDK on its own transport. Tests fill it with a
 * `customFetch` so requests are routed through the global `fetch` that msw patches.
 *
 * This seam is not optional for testing. On Node the SDK resolves npm-undici's own
 * `fetch` paired with a private dispatcher (see
 * `@doist/todoist-sdk/dist/esm/transport/http-dispatcher.js`) rather than calling
 * `globalThis.fetch`, so an msw `setupServer()` never observes those requests and they
 * would escape to the real API. `customFetch` is the one hook the SDK honours ahead of
 * that transport.
 *
 * Read at call time, never captured, so a test installing a transport affects calls
 * already in flight from modules imported earlier.
 */
let options: TodoistApiOptions = {}

export function todoistTransport(): TodoistApiOptions {
  return options
}

/** Test seam. Pass null to restore the SDK's own transport. */
export function setTodoistTransport(next: TodoistApiOptions | null): void {
  options = next ?? {}
}
