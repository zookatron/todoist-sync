import { http, HttpResponse, type RequestHandler } from 'msw'
import { GLASSFROG_BASE_URL } from '../glassfrog/client.js'
import type {
  Action,
  ActionInput,
  Project,
  ProjectInput,
  Role,
} from '../glassfrog/generated/types.gen.js'
import { nextSequence } from './factories/sequence.js'
import { type DeepPartial, deepMerge, Simulator } from './simulator.js'

/** The key seeded integrations should present. Anything else gets a 401. */
export const GLASSFROG_TEST_API_KEY = 'test-glassfrog-key'

/** The key's user, as `/me` reports them and as the default `actor_id` of every item. */
export const ME_ACTOR_ID = 'per_me'

/** Glassfrog list endpoints page at 100 by default; a small page here keeps tests fast. */
const DEFAULT_PER_PAGE = 100

/**
 * A stateful stand-in for the Glassfrog v5 API.
 *
 * Entities live in memory and writes really mutate them, which is what makes the sync
 * loop testable end to end. In particular every write bumps `updated_at`, exactly as
 * Glassfrog does — so our own writes come back as "changes" on the next enumeration, and
 * a test can prove that `contentHash` suppresses the echo rather than assuming it.
 *
 * The generated types in `server/glassfrog/generated/types.gen.ts` are the contract: if
 * the vendored spec changes shape, this stops compiling.
 */
export class GlassfrogSimulator extends Simulator {
  roles: Role[] = []
  projects: Project[] = []
  actions: Action[] = []

  /**
   * The API key's user. New items, and those a test adds without saying otherwise, are on them;
   * a test sets `actor_id` only for a co-filler's items.
   */
  me = { id: ME_ACTOR_ID }

  /** Every action id this simulator has deleted, for asserting a delete really happened. */
  readonly deletedActionIds = new Set<string>()

  override reset(): void {
    this.roles = []
    this.projects = []
    this.actions = []
    this.deletedActionIds.clear()
    this.me = { id: ME_ACTOR_ID }
  }

  addRoles(roles: DeepPartial<Role>[]): Role[] {
    const created = roles.map((role) => deepMerge(defaultRole(), role))
    this.roles.push(...created)
    return created
  }

  addProjects(projects: DeepPartial<Project>[]): Project[] {
    const created = projects.map((project) => deepMerge(defaultProject(), project))
    this.projects.push(...created)
    this.refreshSubProjectFlags()
    return created
  }

  /** Keeps the flag the tree crawl relies on honest, so tests never have to set it. */
  private refreshSubProjectFlags(): void {
    for (const project of this.projects) {
      project.has_sub_projects = this.projects.some(
        (candidate) => candidate.parent_project_id === project.id,
      )
    }
  }

  addActions(actions: DeepPartial<Action>[]): Action[] {
    const created = actions.map((action) => deepMerge(defaultAction(), action))
    this.actions.push(...created)
    return created
  }

  action(id: string): Action | undefined {
    return this.actions.find((action) => action.id === id)
  }

  project(id: string): Project | undefined {
    return this.projects.find((project) => project.id === id)
  }

  /** Every project beneath `id`, at any depth. */
  private subProjectsOf(id: string): Project[] {
    const collected: Project[] = []
    const queue = [id]
    const seen = new Set<string>([id])

    while (queue.length > 0) {
      const parentId = queue.shift()
      for (const child of this.projects.filter((p) => p.parent_project_id === parentId)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        collected.push(child)
        queue.push(child.id)
      }
    }

    return collected
  }

  protected handlers(): RequestHandler[] {
    const url = (path: string) => `${GLASSFROG_BASE_URL}${path}`

    return [
      http.get(url('/me'), ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        return HttpResponse.json({
          data: {
            actor: { id: this.me.id, type: 'actor', name: 'Test Person', kind: 'human' },
            organization: { id: 'org-1', type: 'organization', name: 'Test Org' },
            membership: { id: 'membership-1', type: 'membership' },
          },
        })
      }),

      http.get(url('/me/roles'), ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied
        return this.page(request, this.roles)
      }),

      http.get(url('/roles/:roleId/projects'), ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const roleId = String(params.roleId)

        // The live API returns the role's whole project tree here, not just its top level —
        // nested projects come back too, carrying their real `parent_project_id`, and a
        // sub-project's own `role_id` may even be null. Verified against the real
        // organization. The crawl must therefore key nesting off `parent_project_id` rather
        // than assuming everything in this response hangs off the role.
        //
        // Individual initiatives recorded against the role are left out (verified live): they
        // only come back from `/me/projects?individual_initiative=true`.
        const owned = this.projects.filter(
          (project) => project.role_id === roleId && !project.individual_initiative,
        )
        const withDescendants = [...owned]

        for (const project of owned) {
          for (const descendant of this.subProjectsOf(project.id)) {
            if (!withDescendants.includes(descendant)) withDescendants.push(descendant)
          }
        }

        return this.page(request, this.byActor(request, withDescendants))
      }),

      http.get(url('/me/projects'), ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const initiatives = this.initiativeFilter(request)
        if (initiatives instanceof Response) return initiatives

        // Verified live: the initiative listing is the whole tree, sub-projects included.
        const projects = this.projects.filter(
          (project) => project.individual_initiative === initiatives,
        )
        return this.page(request, this.byActor(request, projects))
      }),

      http.get(url('/projects/:id/sub_projects'), ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const parentId = String(params.id)
        const children = this.projects.filter((p) => p.parent_project_id === parentId)
        return this.page(request, children)
      }),

      http.post(url('/roles/:roleId/projects'), async ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const roleId = String(params.roleId)
        if (!this.roles.some((role) => role.id === roleId)) return notFound('Role')

        const body = (await request.json()) as ProjectInput

        // Verified live: the creator is the project's actor, initiative or not, and an
        // initiative keeps the role it was created through as `role_id`.
        const [project] = this.addProjects([{ role_id: roleId, actor_id: this.me.id }])
        if (!project) return notFound('Project')

        applyProjectInput(project, body)
        // After the input, because that is what sets the parent — and the crawl will not
        // descend into a parent whose flag says it is a leaf.
        this.refreshSubProjectFlags()

        return HttpResponse.json({ data: project }, { status: 201 })
      }),

      http.get(url('/projects/:id'), ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const project = this.project(String(params.id))
        if (!project) return notFound('Project')
        return HttpResponse.json({ data: project })
      }),

      http.patch(url('/projects/:id'), async ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const project = this.project(String(params.id))
        if (!project) return notFound('Project')

        const body = (await request.json()) as ProjectInput
        applyProjectInput(project, body)
        this.touch(project)

        return HttpResponse.json({ data: project })
      }),

      http.get(url('/me/actions'), ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const initiatives = this.initiativeFilter(request)
        if (initiatives instanceof Response) return initiatives

        // Verified live: role actions and individual initiatives never share a listing.
        const actions = this.actions.filter(
          (action) => action.individual_initiative === initiatives,
        )
        return this.page(request, this.byActor(request, actions))
      }),

      http.get(url('/actions/:id'), ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const action = this.action(String(params.id))
        if (!action) return notFound('Action')
        return HttpResponse.json({ data: action })
      }),

      http.post(url('/roles/:roleId/actions'), async ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const roleId = String(params.roleId)
        if (!this.roles.some((role) => role.id === roleId)) return notFound('Role')

        const body = (await request.json()) as ActionInput
        const now = new Date().toISOString()
        const action: Action = {
          ...defaultAction(),
          role_id: roleId,
          actor_id: this.me.id,
          created_at: now,
          updated_at: now,
        }
        applyActionInput(action, body)

        this.actions.push(action)
        return HttpResponse.json({ data: action }, { status: 201 })
      }),

      http.patch(url('/actions/:id'), async ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const action = this.action(String(params.id))
        if (!action) return notFound('Action')

        const body = (await request.json()) as ActionInput
        applyActionInput(action, body)
        this.touch(action)

        return HttpResponse.json({ data: action })
      }),

      http.post(url('/actions/:actionId/completion'), ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const action = this.action(String(params.actionId))
        if (!action) return notFound('Action')

        action.status = 'completed'
        this.touch(action)
        return HttpResponse.json({ data: action })
      }),

      http.delete(url('/actions/:actionId/completion'), ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const action = this.action(String(params.actionId))
        if (!action) return notFound('Action')

        action.status = 'current'
        this.touch(action)
        return HttpResponse.json({ data: action })
      }),

      http.delete(url('/actions/:id'), ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const id = String(params.id)
        const index = this.actions.findIndex((action) => action.id === id)
        if (index === -1) return notFound('Action')

        this.actions.splice(index, 1)
        this.deletedActionIds.add(id)
        return new HttpResponse(null, { status: 204 })
      }),
    ]
  }

  /**
   * Advances `updated_at` past its current value.
   *
   * Guarded rather than a plain `new Date()`: tests run fast enough that two writes can
   * land in the same millisecond, and a timestamp that failed to move would hide exactly
   * the last-write-wins bugs these tests exist to catch.
   */
  private touch(entity: { updated_at: string }): void {
    const now = Date.now()
    const previous = Date.parse(entity.updated_at)
    entity.updated_at = new Date(
      Number.isNaN(previous) ? now : Math.max(now, previous + 1),
    ).toISOString()
  }

  /**
   * `individual_initiative` as the list endpoints read it: absent or `false` is role items,
   * `true` is initiatives, and anything else a 422 (verified live).
   */
  private initiativeFilter(request: Request): boolean | Response {
    const value = new URL(request.url).searchParams.get('individual_initiative')
    if (value === null || value === 'false') return false
    if (value === 'true') return true
    return HttpResponse.json(
      {
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'individual_initiative must be true or false',
      },
      { status: 422 },
    )
  }

  /** `?actor_id=` keeps one actor's items; an unknown id is an empty list, not an error. */
  private byActor<T extends { actor_id?: string | null }>(request: Request, items: T[]): T[] {
    const actorId = new URL(request.url).searchParams.get('actor_id')
    return actorId === null ? items : items.filter((item) => item.actor_id === actorId)
  }

  /** Glassfrog v5 authenticates with a static key in `X-Auth-Token`. */
  private authorize(request: Request): Response | null {
    if (request.headers.get('X-Auth-Token') === GLASSFROG_TEST_API_KEY) return null
    return HttpResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  /**
   * Answers with the cursor-paginated envelope `paginateAll` expects.
   *
   * Really paginates rather than returning everything in one page, so the cursor loop —
   * and its runaway guard — are exercised by any test with more than a page of data.
   */
  private page<T>(request: Request, items: T[]): Response {
    const query = new URL(request.url).searchParams
    const perPage = Number(query.get('per_page') ?? DEFAULT_PER_PAGE) || DEFAULT_PER_PAGE
    const start = Number(query.get('cursor') ?? 0) || 0
    const end = start + perPage
    const hasNextPage = end < items.length

    return HttpResponse.json({
      data: items.slice(start, end),
      meta: {
        pagination: {
          per_page: perPage,
          has_next_page: hasNextPage,
          ...(hasNextPage ? { next_cursor: String(end) } : {}),
        },
      },
    })
  }
}

function notFound(entity: string): Response {
  return HttpResponse.json({ error: `${entity} not found` }, { status: 404 })
}

/**
 * Applies the fields the application actually writes.
 *
 * Field by field rather than a spread: `ActionInput` and `Action` are related but not
 * identical (`permissions` differs), and an absent key must leave the stored value alone
 * rather than blank it.
 */
function applyActionInput(action: Action, body: ActionInput): void {
  const input = body.action_item
  if (!input) return

  if (input.description !== undefined) action.description = input.description
  if (input.note !== undefined) action.note = input.note
  if (input.status !== undefined) action.status = input.status
  if (input.parent_project_id !== undefined) action.parent_project_id = input.parent_project_id
  if (input.individual_initiative !== undefined) {
    action.individual_initiative = input.individual_initiative
  }
}

/** The project counterpart of {@link applyActionInput}, and field by field for the same reason. */
function applyProjectInput(project: Project, body: ProjectInput): void {
  const input = body.project
  if (!input) return

  if (input.description !== undefined) project.description = input.description
  if (input.status !== undefined) project.status = input.status
  if (input.note !== undefined) project.note = input.note
  if (input.link !== undefined) project.link = input.link
  if (input.value !== undefined) project.value = input.value
  if (input.effort !== undefined) project.effort = input.effort
  if (input.parent_project_id !== undefined) project.parent_project_id = input.parent_project_id
  if (input.individual_initiative !== undefined) {
    project.individual_initiative = input.individual_initiative
  }
}

function defaultRole(): Role {
  const n = nextSequence('glassfrog-role')
  return {
    id: `role-${n}`,
    type: 'role',
    name: `Role ${n}`,
    purpose: null,
    parent_role_id: null,
    original_role_id: null,
    has_subroles: false,
    flags: [],
    accountabilities: [],
    domains: [],
    fillers: [],
    tags: [],
  }
}

function defaultProject(): Project {
  const n = nextSequence('glassfrog-project')
  const now = new Date().toISOString()
  return {
    id: `project-${n}`,
    type: 'project',
    description: `Project ${n}`,
    status: 'current',
    role_id: 'role-1',
    actor_id: ME_ACTOR_ID,
    individual_initiative: false,
    has_sub_projects: false,
    has_actions: false,
    parent_project_id: null,
    tags: [],
    link: null,
    note: null,
    value: null,
    effort: null,
    created_at: now,
    updated_at: now,
  }
}

function defaultAction(): Action {
  const n = nextSequence('glassfrog-action')
  const now = new Date().toISOString()
  return {
    id: `action-${n}`,
    type: 'action',
    description: `Action ${n}`,
    status: 'current',
    role_id: 'role-1',
    actor_id: ME_ACTOR_ID,
    individual_initiative: false,
    parent_project_id: null,
    tags: [],
    created_at: now,
    updated_at: now,
    note: null,
  }
}
