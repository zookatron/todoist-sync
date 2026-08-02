import { randomUUID } from 'node:crypto'
import { TodoistApi, TodoistRequestError } from '@doist/todoist-sdk'
import { logger } from '../utils/logger.js'
import { getValidAccessToken } from './oauth.js'

/** Builds a client bound to the user's current access token. */
export async function getTodoistApi(userId: string): Promise<TodoistApi> {
  return new TodoistApi(await getValidAccessToken(userId))
}

function retryAfterMs(error: TodoistRequestError): number | null {
  const data = error.responseData
  if (data && typeof data === 'object' && 'retryAfter' in data) {
    const seconds = Number(data.retryAfter)
    if (Number.isFinite(seconds)) return seconds * 1000
  }
  return null
}

/**
 * Runs a Todoist call with token and rate-limit recovery.
 *
 * - **401**: our expiry bookkeeping disagreed with the server (clock skew, a token
 *   revoked early). Force a refresh and retry once with a fresh client.
 * - **429**: back off for `Retry-After` and retry, up to `maxRetries`.
 *
 * Prefer this over calling a raw {@link TodoistApi} in background jobs.
 */
export async function callTodoist<T>(
  userId: string,
  fn: (api: TodoistApi) => Promise<T>,
  options: { maxRetries?: number } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  let refreshed = false

  for (let attempt = 0; ; attempt++) {
    const api = new TodoistApi(await getValidAccessToken(userId, refreshed))

    try {
      return await fn(api)
    } catch (error) {
      if (!(error instanceof TodoistRequestError)) throw error

      if (error.httpStatusCode === 401 && !refreshed) {
        logger.warn({ userId }, 'Todoist returned 401; forcing a token refresh')
        refreshed = true
        continue
      }

      const isRetryable = error.httpStatusCode === 429 || (error.httpStatusCode ?? 0) >= 500
      if (!isRetryable || attempt >= maxRetries) throw error

      // Exponential backoff unless the server told us exactly how long to wait.
      const delay = retryAfterMs(error) ?? Math.min(30_000, 1000 * 2 ** attempt)
      logger.warn(
        { userId, status: error.httpStatusCode, delay, attempt },
        'Todoist request failed; retrying',
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * Re-parents a Todoist project.
 *
 * The REST `updateProject` endpoint cannot change a project's parent — `UpdateProjectArgs`
 * has no `parentId`. Moving is only expressible as the Sync API's `project_move` command,
 * so the hierarchy mirror goes through here.
 *
 * @param parentId the new parent, or null to move the project to the top level.
 */
export async function moveTodoistProject(
  userId: string,
  projectId: string,
  parentId: string | null,
): Promise<void> {
  await callTodoist(userId, async (api) => {
    const response = await api.sync({
      commands: [
        {
          type: 'project_move',
          uuid: randomUUID(),
          args: { id: projectId, parentId },
        },
      ],
    })

    // The Sync API reports per-command failures in the body with a 200 status, so a
    // thrown error is not enough to detect a failed move.
    for (const [uuid, status] of Object.entries(response.syncStatus ?? {})) {
      if (status !== 'ok') {
        throw new Error(
          `Todoist project_move failed (${uuid}): ${'error' in status ? status.error : 'unknown error'}`,
        )
      }
    }
  })
}
