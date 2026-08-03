import { eq } from 'drizzle-orm'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/index.js'
import { todoistIntegration } from '../db/schema/integrations.js'
import { projectMapping, syncLog } from '../db/schema/sync.js'
import {
  connectedUser,
  DatabaseSimulator,
  GlassfrogSimulator,
  ProjectMappingFactory,
  TodoistSimulator,
} from '../testing/index.js'
import { syncHierarchy } from './hierarchy.js'

/**
 * `syncHierarchy` end to end: real Glassfrog crawl, real Todoist writes, real mapping rows.
 *
 * Nothing here is mocked. The Glassfrog simulator serves a role/project graph over its
 * paginated endpoints, the Todoist simulator applies the resulting creates, renames and
 * moves to its own store, and the assertions read both the mapping table and the resulting
 * Todoist tree. That makes the interesting part — ordering, and resolving a parent that is
 * created in the same pass — observable rather than inferred.
 */
new DatabaseSimulator()
const glassfrog = new GlassfrogSimulator()
const todoist = new TodoistSimulator()

const ROOT = 'td-root'

let userId: string

beforeEach(async () => {
  userId = (await connectedUser({ rootProjectId: ROOT })).user.id
  todoist.addProjects([{ id: ROOT, name: 'Glassfrog' }])
})

/** Todoist projects beneath the root, as `name → parent name`. */
function todoistTree(): Record<string, string | null> {
  const nameById = new Map(todoist.projects.map((project) => [project.id, project.name]))
  return Object.fromEntries(
    todoist.projects
      .filter((project) => project.id !== ROOT && !project.is_archived)
      .map((project) => [
        project.name,
        project.parent_id ? (nameById.get(project.parent_id) ?? null) : null,
      ]),
  )
}

function mappings() {
  return db.select().from(projectMapping).where(eq(projectMapping.userId, userId))
}

describe('syncHierarchy', () => {
  it('does nothing when no root project is configured', async () => {
    await db.update(todoistIntegration).set({ rootTodoistProjectId: null })

    expect(await syncHierarchy(userId)).toEqual({
      created: 0,
      renamed: 0,
      moved: 0,
      archived: 0,
      skipped: 0,
    })
  })

  it('mirrors roles and their nested projects, parents before children', async () => {
    glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
    glassfrog.addProjects([
      { id: 'proj-api', description: 'API rewrite', role_id: 'role-eng' },
      {
        id: 'proj-auth',
        description: 'Auth module',
        role_id: 'role-eng',
        parent_project_id: 'proj-api',
      },
    ])

    const result = await syncHierarchy(userId)

    expect(result.created).toBe(3)
    expect(todoistTree()).toEqual({
      Engineering: 'Glassfrog',
      'API rewrite': 'Engineering',
      // A child created after its parent in the same pass still resolves it: the id map
      // is mutated as the loop runs.
      'Auth module': 'API rewrite',
    })

    const rows = await mappings()
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.glassfrogId === 'proj-auth')?.parentGlassfrogId).toBe('proj-api')
  })

  it('skips Glassfrog projects that are no longer live', async () => {
    glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
    glassfrog.addProjects([
      { id: 'proj-live', description: 'Live', role_id: 'role-eng', status: 'current' },
      { id: 'proj-done', description: 'Done', role_id: 'role-eng', status: 'completed' },
      { id: 'proj-gone', description: 'Cancelled', role_id: 'role-eng', status: 'cancelled' },
    ])

    await syncHierarchy(userId)

    expect(Object.keys(todoistTree()).sort()).toEqual(['Engineering', 'Live'])
  })

  it('renames a Todoist project when the Glassfrog name changes', async () => {
    glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
    await syncHierarchy(userId)

    const created = todoist.projects.find((project) => project.name === 'Engineering')
    glassfrog.roles[0]!.name = 'Platform Engineering'

    const result = await syncHierarchy(userId)

    expect(result.renamed).toBe(1)
    expect(result.created).toBe(0)
    expect(todoist.project(created!.id)?.name).toBe('Platform Engineering')
  })

  it('re-parents a project through the Sync API when it moves in Glassfrog', async () => {
    glassfrog.addRoles([
      { id: 'role-a', name: 'Role A' },
      { id: 'role-b', name: 'Role B' },
    ])
    glassfrog.addProjects([{ id: 'proj-1', description: 'Movable', role_id: 'role-a' }])

    await syncHierarchy(userId)
    expect(todoistTree()['Movable']).toBe('Role A')

    // The project now belongs to the other role.
    glassfrog.projects[0]!.role_id = 'role-b'

    const result = await syncHierarchy(userId)

    expect(result.moved).toBe(1)
    expect(todoistTree()['Movable']).toBe('Role B')
  })

  it('archives an orphaned Todoist project and drops its mapping', async () => {
    glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
    await syncHierarchy(userId)

    const created = todoist.projects.find((project) => project.name === 'Engineering')!
    // The role disappears from Glassfrog.
    glassfrog.roles = []

    const result = await syncHierarchy(userId)

    expect(result.archived).toBe(1)
    expect(todoist.archivedProjectIds.has(created.id)).toBe(true)
    // Archived rather than deleted: recoverable if the mirror was wrong.
    expect(todoist.project(created.id)?.is_deleted).toBe(false)
    expect(await mappings()).toHaveLength(0)
  })

  it('prunes mappings whose Todoist project has vanished', async () => {
    glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
    await new ProjectMappingFactory()
      .override({ userId })
      .forRole('role-ghost', 'td-project-deleted-by-hand')
      .make()

    await syncHierarchy(userId)

    const remaining = (await mappings()).map((row) => row.glassfrogId)
    expect(remaining).not.toContain('role-ghost')
  })

  it('is idempotent: a second pass with no changes does nothing', async () => {
    glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
    glassfrog.addProjects([{ id: 'proj-api', description: 'API', role_id: 'role-eng' }])

    await syncHierarchy(userId)
    const second = await syncHierarchy(userId)

    expect(second).toEqual({ created: 0, renamed: 0, moved: 0, archived: 0, skipped: 0 })
    expect(todoist.projects.filter((p) => p.name === 'API')).toHaveLength(1)
  })

  it('crawls every page of a paginated role list', async () => {
    // per_page is 100, so 150 roles forces the cursor loop to run twice.
    glassfrog.addRoles(Array.from({ length: 150 }, (_, i) => ({ id: `role-${i}`, name: `R${i}` })))

    const result = await syncHierarchy(userId)

    expect(result.created).toBe(150)
  })

  it('records a failed operation and keeps going', async () => {
    glassfrog.addRoles([
      { id: 'role-a', name: 'Role A' },
      { id: 'role-b', name: 'Role B' },
    ])

    // Fail the first create only; the rest of the pass must still complete.
    // Returning undefined falls through to the simulator's own handler.
    let calls = 0
    todoist.useForTest([
      http.post('https://api.todoist.com/api/v1/projects', () => {
        calls += 1
        return calls === 1 ? HttpResponse.json({ error: 'boom' }, { status: 400 }) : undefined
      }),
    ])

    const result = await syncHierarchy(userId)

    expect(result.created).toBe(1)

    const logs = await db.select().from(syncLog).where(eq(syncLog.userId, userId))
    expect(logs.some((log) => log.description.startsWith('Operation failed'))).toBe(true)
  })
})
