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
import { emptyHierarchyResult, syncHierarchy } from './hierarchy.js'

/**
 * `syncHierarchy` end to end: real Glassfrog crawl, real Todoist writes, real mapping rows.
 *
 * Nothing here is mocked. The Glassfrog simulator serves a role/project graph over its
 * paginated endpoints, the Todoist simulator applies the resulting creates, renames and
 * moves to its own store, and the assertions read both the mapping table and the resulting
 * Todoist tree. That makes the interesting part — ordering, resolving a parent created in
 * the same pass, and which side wins a disagreement — observable rather than inferred.
 *
 * The two-way cases lean on the simulators' real `touch()` behaviour: a write bumps
 * `updated_at` strictly forward, which is what the status and name rules compare.
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

function logDescriptions() {
  return db
    .select({ description: syncLog.description })
    .from(syncLog)
    .where(eq(syncLog.userId, userId))
    .then((rows) => rows.map((row) => row.description))
}

/** Seeds a role mirrored on both sides, the starting point for the Todoist-first cases. */
async function mirroredRole(glassfrogId = 'role-eng', todoistId = 'td-eng') {
  glassfrog.addRoles([{ id: glassfrogId, name: 'Engineering' }])
  todoist.addProjects([{ id: todoistId, name: 'Engineering', parent_id: ROOT }])
  await new ProjectMappingFactory().override({ userId }).forRole(glassfrogId, todoistId).make()
  return { glassfrogId, todoistId }
}

describe('syncHierarchy', () => {
  it('does nothing when no root project is configured', async () => {
    await db.update(todoistIntegration).set({ rootTodoistProjectId: null })

    expect(await syncHierarchy(userId)).toEqual(emptyHierarchyResult())
  })

  describe('Glassfrog → Todoist', () => {
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

      expect(result['create-todoist']).toBe(3)
      expect(todoistTree()).toEqual({
        Engineering: 'Glassfrog',
        'API rewrite': 'Engineering',
        // A child created after its parent in the same pass still resolves it: the id map
        // is mutated as the loop runs.
        'Auth module': 'API rewrite',
      })

      const rows = await mappings()
      expect(rows).toHaveLength(3)
      expect(rows.find((row) => row.glassfrogId === 'proj-auth')?.parentGlassfrogId).toBe(
        'proj-api',
      )
    })

    it('does not mirror Glassfrog projects that are already finished', async () => {
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

      expect(result['rename-todoist']).toBe(1)
      expect(result['create-todoist']).toBe(0)
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

      expect(result['move-todoist']).toBe(1)
      expect(todoistTree()['Movable']).toBe('Role B')
      // The stored chain follows the move, because adoption and the task job walk it.
      const row = (await mappings()).find((m) => m.glassfrogId === 'proj-1')
      expect(row?.parentGlassfrogId).toBe('role-b')
    })

    it('archives a Todoist project whose Glassfrog node disappeared and drops its mapping', async () => {
      glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
      await syncHierarchy(userId)

      const created = todoist.projects.find((project) => project.name === 'Engineering')!
      // The role disappears from Glassfrog.
      glassfrog.roles = []

      const result = await syncHierarchy(userId)

      expect(result['archive-todoist']).toBe(1)
      expect(todoist.archivedProjectIds.has(created.id)).toBe(true)
      // Archived rather than deleted: recoverable if the mirror was wrong.
      expect(todoist.project(created.id)?.is_deleted).toBe(false)
      expect(await mappings()).toHaveLength(0)
    })

    it('archives the Todoist mirror when Glassfrog completes the project', async () => {
      glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
      glassfrog.addProjects([{ id: 'proj-api', description: 'API', role_id: 'role-eng' }])
      await syncHierarchy(userId)

      const created = todoist.projects.find((project) => project.name === 'API')!

      // Completed in Glassfrog, which bumps its `updated_at` past Todoist's.
      glassfrog.projects[0]!.status = 'completed'
      glassfrog.projects[0]!.updated_at = new Date(Date.now() + 60_000).toISOString()

      const result = await syncHierarchy(userId)

      expect(result['archive-todoist']).toBe(1)
      expect(todoist.archivedProjectIds.has(created.id)).toBe(true)
      // The mapping survives as a tombstone, so unarchiving later reopens rather than
      // creating a second Glassfrog project.
      expect((await mappings()).map((m) => m.glassfrogId)).toContain('proj-api')
    })

    it('rebuilds a mirror project the user deleted outright', async () => {
      glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
      await syncHierarchy(userId)

      const created = todoist.projects.find((project) => project.name === 'Engineering')!
      created.is_deleted = true

      const result = await syncHierarchy(userId)

      expect(result['create-todoist']).toBe(1)
      expect(todoistTree()['Engineering']).toBe('Glassfrog')
    })
  })

  describe('Todoist → Glassfrog', () => {
    it('creates a Glassfrog project for one born inside a role', async () => {
      const { glassfrogId } = await mirroredRole()
      todoist.addProjects([{ id: 'td-new', name: 'Rebrand', parent_id: 'td-eng' }])

      const result = await syncHierarchy(userId)

      expect(result['create-glassfrog']).toBe(1)

      const created = glassfrog.projects.find((project) => project.description === 'Rebrand')
      expect(created).toBeDefined()
      expect(created?.role_id).toBe(glassfrogId)
      expect(created?.parent_project_id).toBeNull()
      expect(created?.status).toBe('current')

      const row = (await mappings()).find((m) => m.todoistProjectId === 'td-new')
      expect(row).toMatchObject({
        kind: 'project',
        glassfrogId: created!.id,
        parentGlassfrogId: glassfrogId,
      })
    })

    it('creates a Glassfrog sub-project for one born inside a mapped project', async () => {
      await mirroredRole()
      glassfrog.addProjects([{ id: 'proj-api', description: 'API', role_id: 'role-eng' }])
      await syncHierarchy(userId)

      const apiProject = todoist.projects.find((project) => project.name === 'API')!
      todoist.addProjects([{ id: 'td-sub', name: 'Tokens', parent_id: apiProject.id }])

      const result = await syncHierarchy(userId)

      expect(result['create-glassfrog']).toBe(1)

      const created = glassfrog.projects.find((project) => project.description === 'Tokens')
      expect(created?.parent_project_id).toBe('proj-api')
      expect(created?.role_id).toBe('role-eng')
    })

    it('adopts a chain created in one pass, resolving each new parent as it goes', async () => {
      await mirroredRole()
      todoist.addProjects([
        { id: 'td-mid', name: 'Mid', parent_id: 'td-eng' },
        { id: 'td-deep', name: 'Deep', parent_id: 'td-mid' },
      ])

      const result = await syncHierarchy(userId)

      expect(result['create-glassfrog']).toBe(2)

      const mid = glassfrog.projects.find((project) => project.description === 'Mid')!
      const deep = glassfrog.projects.find((project) => project.description === 'Deep')!
      // Deep's parent is a project that did not exist when the pass began.
      expect(deep.parent_project_id).toBe(mid.id)
      expect(deep.role_id).toBe('role-eng')
    })

    it('leaves a hand-made project directly under the root alone', async () => {
      await mirroredRole()
      todoist.addProjects([{ id: 'td-mine', name: 'Groceries', parent_id: ROOT }])

      const result = await syncHierarchy(userId)

      expect(result).toEqual(emptyHierarchyResult())
      expect(todoist.archivedProjectIds.has('td-mine')).toBe(false)
      expect(glassfrog.projects).toHaveLength(0)
    })

    it('completes the Glassfrog project when its Todoist mirror is archived', async () => {
      await mirroredRole()
      glassfrog.addProjects([{ id: 'proj-api', description: 'API', role_id: 'role-eng' }])
      await syncHierarchy(userId)

      const created = todoist.projects.find((project) => project.name === 'API')!
      // Archiving bumps Todoist's `updated_at` past Glassfrog's, so Todoist wins.
      created.is_archived = true
      created.updated_at = new Date(Date.now() + 60_000).toISOString()

      const result = await syncHierarchy(userId)

      expect(result['complete-glassfrog']).toBe(1)
      expect(glassfrog.project('proj-api')?.status).toBe('completed')
      // Tombstoned, not dropped.
      expect((await mappings()).map((m) => m.glassfrogId)).toContain('proj-api')

      const logs = await logDescriptions()
      expect(logs.some((line) => line.includes('still need finishing in Glassfrog'))).toBe(true)
    })

    it('completes a whole archived sub-tree together', async () => {
      await mirroredRole()
      glassfrog.addProjects([
        { id: 'proj-api', description: 'API', role_id: 'role-eng' },
        {
          id: 'proj-sub',
          description: 'Tokens',
          role_id: 'role-eng',
          parent_project_id: 'proj-api',
        },
      ])
      await syncHierarchy(userId)

      // Only the parent is flagged; the child inherits it through the tree walk.
      const parent = todoist.projects.find((project) => project.name === 'API')!
      parent.is_archived = true
      parent.updated_at = new Date(Date.now() + 60_000).toISOString()

      const result = await syncHierarchy(userId)

      expect(result['complete-glassfrog']).toBe(2)
      expect(glassfrog.project('proj-api')?.status).toBe('completed')
      expect(glassfrog.project('proj-sub')?.status).toBe('completed')
    })

    it('reopens the Glassfrog project when the archived mirror comes back', async () => {
      await mirroredRole()
      glassfrog.addProjects([
        { id: 'proj-api', description: 'API', role_id: 'role-eng', status: 'completed' },
      ])
      todoist.addProjects([{ id: 'td-api', name: 'API', parent_id: 'td-eng', is_archived: true }])
      await new ProjectMappingFactory()
        .override({ userId })
        .forProject('proj-api', 'td-api', 'role-eng')
        .make()

      // Converged to begin with.
      expect(await syncHierarchy(userId)).toEqual(emptyHierarchyResult())

      // Now the user unarchives it, which bumps Todoist's timestamp.
      const project = todoist.project('td-api')!
      project.is_archived = false
      project.updated_at = new Date(Date.now() + 60_000).toISOString()

      const result = await syncHierarchy(userId)

      expect(result['reopen-glassfrog']).toBe(1)
      expect(glassfrog.project('proj-api')?.status).toBe('current')
    })

    it('unarchives a role project rather than completing anything', async () => {
      const { todoistId } = await mirroredRole()

      const project = todoist.project(todoistId)!
      project.is_archived = true
      project.updated_at = new Date(Date.now() + 60_000).toISOString()

      const result = await syncHierarchy(userId)

      expect(result['unarchive-todoist']).toBe(1)
      expect(todoist.project(todoistId)?.is_archived).toBe(false)
      // The mapping survives, so the tasks inside stay addressable in the mirrored tree.
      expect(await mappings()).toHaveLength(1)
    })

    it('pushes a Todoist rename back to Glassfrog when it is the newer one', async () => {
      await mirroredRole()
      glassfrog.addProjects([{ id: 'proj-api', description: 'API', role_id: 'role-eng' }])
      await syncHierarchy(userId)

      const created = todoist.projects.find((project) => project.name === 'API')!
      created.name = 'API v2'
      created.updated_at = new Date(Date.now() + 60_000).toISOString()

      const result = await syncHierarchy(userId)

      expect(result['rename-glassfrog']).toBe(1)
      expect(glassfrog.project('proj-api')?.description).toBe('API v2')
    })

    it('reverts a role rename, since roles carry no timestamp to compare', async () => {
      const { todoistId } = await mirroredRole()

      const project = todoist.project(todoistId)!
      project.name = 'Eng (mine)'
      project.updated_at = new Date(Date.now() + 60_000).toISOString()

      const result = await syncHierarchy(userId)

      expect(result['rename-todoist']).toBe(1)
      expect(todoist.project(todoistId)?.name).toBe('Engineering')
    })
  })

  describe('housekeeping and resilience', () => {
    it('drops mappings whose Todoist project has vanished', async () => {
      glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
      await new ProjectMappingFactory()
        .override({ userId })
        .forRole('role-ghost', 'td-project-deleted-by-hand')
        .make()

      const result = await syncHierarchy(userId)

      expect(result['drop-mapping']).toBe(1)
      const remaining = (await mappings()).map((row) => row.glassfrogId)
      expect(remaining).not.toContain('role-ghost')
    })

    it('is idempotent: a second pass with no changes does nothing', async () => {
      glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
      glassfrog.addProjects([{ id: 'proj-api', description: 'API', role_id: 'role-eng' }])

      await syncHierarchy(userId)
      const second = await syncHierarchy(userId)

      expect(second).toEqual(emptyHierarchyResult())
      expect(todoist.projects.filter((p) => p.name === 'API')).toHaveLength(1)
    })

    it('settles after an adoption rather than creating a second project', async () => {
      // The echo case: the adopted project now exists on both sides, so the next pass must
      // recognise it instead of mirroring the new Glassfrog node back into Todoist.
      await mirroredRole()
      todoist.addProjects([{ id: 'td-new', name: 'Rebrand', parent_id: 'td-eng' }])

      await syncHierarchy(userId)
      const second = await syncHierarchy(userId)

      expect(second).toEqual(emptyHierarchyResult())
      expect(glassfrog.projects.filter((p) => p.description === 'Rebrand')).toHaveLength(1)
      expect(todoist.projects.filter((p) => p.name === 'Rebrand')).toHaveLength(1)
    })

    it('settles after a completion rather than reopening it again', async () => {
      await mirroredRole()
      glassfrog.addProjects([{ id: 'proj-api', description: 'API', role_id: 'role-eng' }])
      await syncHierarchy(userId)

      const created = todoist.projects.find((project) => project.name === 'API')!
      created.is_archived = true
      created.updated_at = new Date(Date.now() + 60_000).toISOString()

      await syncHierarchy(userId)
      const third = await syncHierarchy(userId)

      expect(third).toEqual(emptyHierarchyResult())
      expect(glassfrog.project('proj-api')?.status).toBe('completed')
    })

    it('crawls every page of a paginated role list', async () => {
      // per_page is 100, so 150 roles forces the cursor loop to run twice.
      glassfrog.addRoles(
        Array.from({ length: 150 }, (_, i) => ({ id: `role-${i}`, name: `R${i}` })),
      )

      const result = await syncHierarchy(userId)

      expect(result['create-todoist']).toBe(150)
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

      expect(result['create-todoist']).toBe(1)
      expect(result.failed).toBe(1)

      const logs = await logDescriptions()
      expect(logs.some((line) => line.startsWith('Operation failed'))).toBe(true)
    })
  })
})
