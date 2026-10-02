import type { Client } from './generated/client/index.js'
import { createRoleProject, updateProject } from './generated/sdk.gen.js'
import type { Project } from './generated/types.gen.js'

/**
 * Glassfrog project writes.
 *
 * Thin wrappers over the generated SDK, so the `{ project: { … } }` body envelope and the
 * status vocabulary live in one place rather than being re-derived at each call site.
 *
 * Note the asymmetry with actions: an action is completed through a dedicated sub-resource
 * (`POST /actions/{id}/completion`), but a project has no such endpoint — completing one is
 * a plain status write.
 */

/** A project status meaning the project is done with and no longer mirrored. */
export const GLASSFROG_PROJECT_COMPLETED = 'completed'

/** The status a project is reopened to. */
export const GLASSFROG_PROJECT_CURRENT = 'current'

/**
 * Creates a project owned by a role.
 *
 * There is no way to create a project without a role — `POST /roles/{role_id}/projects` is
 * the only creation endpoint — which is why the mirror can adopt a Todoist project only
 * when it sits somewhere under a mapped role.
 *
 * @param parentProjectId the Glassfrog project to nest under, or null for a top-level
 * project on the role.
 */
export async function createProject(
  client: Client,
  args: { roleId: string; parentProjectId: string | null; name: string },
): Promise<Project> {
  const response = await createRoleProject({
    client,
    path: { role_id: args.roleId },
    body: {
      project: {
        description: args.name,
        status: GLASSFROG_PROJECT_CURRENT,
        parent_project_id: args.parentProjectId,
      },
    },
    throwOnError: true,
  })

  return response.data.data
}

export async function setProjectStatus(
  client: Client,
  projectId: string,
  status: typeof GLASSFROG_PROJECT_COMPLETED | typeof GLASSFROG_PROJECT_CURRENT,
): Promise<Project> {
  const response = await updateProject({
    client,
    path: { id: projectId },
    body: { project: { status } },
    throwOnError: true,
  })

  return response.data.data
}

/** A Glassfrog project's title is its `description`; it has no `name` field. */
export async function renameProject(
  client: Client,
  projectId: string,
  name: string,
): Promise<Project> {
  const response = await updateProject({
    client,
    path: { id: projectId },
    body: { project: { description: name } },
    throwOnError: true,
  })

  return response.data.data
}
