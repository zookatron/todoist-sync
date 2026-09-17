import { randomUUID } from 'node:crypto'
import { TodoistApi, TodoistRequestError } from '@doist/todoist-sdk'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { todoistIntegration } from '../db/schema/integrations.js'
import { logger } from '../utils/logger.js'
import { todoistTransport } from './transport.js'

/** Builds a client authenticated with a specific personal API token. */
export function createTodoistClient(apiKey: string): TodoistApi {
  return new TodoistApi(apiKey, todoistTransport())
}

/** Builds a client from the user's stored token. */
export async function getTodoistApi(userId: string): Promise<TodoistApi> {
  const integration = await db.query.todoistIntegration.findFirst({
    where: eq(todoistIntegration.userId, userId),
  })

  if (!integration) throw new Error(`User ${userId} has not connected Todoist`)

  return createTodoistClient(integration.apiKey)
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
 * Runs a Todoist call with rate-limit recovery.
 *
 * **429/5xx**: back off for `Retry-After` (or exponentially) and retry, up to
 * `maxRetries`. Anything else — including a 401, which means the stored token is
 * simply bad — is not retryable.
 *
 * Prefer this over calling a raw {@link TodoistApi} in background jobs.
 */
export async function callTodoist<T>(
  userId: string,
  fn: (api: TodoistApi) => Promise<T>,
  options: { maxRetries?: number } = {},
): Promise<T> {
  const api = await getTodoistApi(userId)
  const maxRetries = options.maxRetries ?? 3

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(api)
    } catch (error) {
      if (!(error instanceof TodoistRequestError)) throw error

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
