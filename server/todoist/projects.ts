import { randomUUID } from 'node:crypto'
import type { PersonalProject, WorkspaceProject } from '@doist/todoist-sdk'
import { callTodoist } from './client.js'

/**
 * Every project-level Todoist call the hierarchy mirror makes.
 *
 * Kept together because the mirror reads and writes projects from several places — the
 * reconciler, the root-project picker — and because two of these are easy to get wrong:
 * re-parenting is not expressible over REST at all, and archived projects are invisible to
 * the ordinary listing.
 *
 * Everything goes through {@link callTodoist}, which supplies the stored token, the
 * rate-limit retry policy, and the transport seam the test simulators hook. A Todoist call
 * that bypasses it reaches the real API even in tests.
 */

/** A Todoist project, narrowed to the fields the mirror reasons about. */
export type TodoistProject = {
  id: string
  name: string
  parentId: string | null
  archived: boolean
  updatedAt: Date | null
}

function toProject(project: PersonalProject | WorkspaceProject): TodoistProject {
  return {
    id: project.id,
    name: project.name,
    // Workspace projects have no parent; only personal projects nest.
    parentId: 'parentId' in project ? (project.parentId ?? null) : null,
    archived: project.isArchived,
    updatedAt: project.updatedAt ?? null,
  }
}

/** Every project the user can see, excluding archived ones. */
export async function listActiveProjects(userId: string): Promise<TodoistProject[]> {
  return callTodoist(userId, async (api) => {
    const collected: TodoistProject[] = []
    let cursor: string | null = null

    do {
      const page = await api.getProjects(cursor ? { cursor } : {})
      collected.push(...page.results.map(toProject))
      cursor = page.nextCursor ?? null
    } while (cursor)

    return collected
  })
}

/**
 * Every archived project.
 *
 * Archiving drops a project out of `GET /projects` entirely, which makes it
 * indistinguishable from a deletion. This endpoint is what tells the two apart, and
 * telling them apart is what lets an archive mean "completed" rather than "recreate it".
 */
export async function listArchivedProjects(userId: string): Promise<TodoistProject[]> {
  return callTodoist(userId, async (api) => {
    const collected: TodoistProject[] = []
    let cursor: string | null = null

    do {
      const page = await api.getArchivedProjects(cursor ? { cursor } : {})
      collected.push(...page.results.map(toProject))
      cursor = page.nextCursor ?? null
    } while (cursor)

    return collected
  })
}

export async function addProject(
  userId: string,
  args: { name: string; parentId: string },
): Promise<TodoistProject> {
  return toProject(await callTodoist(userId, (api) => api.addProject(args)))
}

export async function renameProject(
  userId: string,
  projectId: string,
  name: string,
): Promise<void> {
  await callTodoist(userId, (api) => api.updateProject(projectId, { name }))
}

/** Archives rather than deletes, so a wrong mirror decision stays recoverable in Todoist. */
export async function archiveProject(userId: string, projectId: string): Promise<void> {
  await callTodoist(userId, (api) => api.archiveProject(projectId))
}

export async function unarchiveProject(userId: string, projectId: string): Promise<void> {
  await callTodoist(userId, (api) => api.unarchiveProject(projectId))
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
export async function moveProject(
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
