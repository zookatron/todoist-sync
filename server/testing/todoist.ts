import { http, HttpResponse, type RequestHandler } from 'msw'
import type { CustomFetch } from '@doist/todoist-sdk'
import type { ItemSyncView, PersonalProjectSyncView } from '../todoist/generated/types.gen.js'
import { setTodoistTransport } from '../todoist/transport.js'
import { nextSequence } from './factories/sequence.js'
import { type DeepPartial, deepMerge, Simulator } from './simulator.js'

const API = 'https://api.todoist.com/api/v1'

/** The token seeded integrations should present. */
export const TODOIST_TEST_API_KEY = 'test-todoist-api-key'

const DEFAULT_PAGE_SIZE = 50

type SyncCommand = {
  type: string
  uuid: string
  /** Only the `project_move` arguments are modelled; that is the sole command in use. */
  args?: { id?: string; parent_id?: string | null }
}

/**
 * A stateful stand-in for the Todoist API v1.
 *
 * Answers in the **wire** format — snake_case, typed against the generated
 * `ItemSyncView` / `PersonalProjectSyncView` — so `@doist/todoist-sdk` does its real
 * camelCase conversion, zod validation and error mapping on the way through. Tests
 * therefore cover the SDK boundary rather than replacing it.
 *
 * Two behaviours here carry the weight:
 *
 * - **A monotonic version counter.** Every mutation stamps the next version on the entity,
 *   and `/sync` with a token returns only what changed since. That is a faithful model of
 *   Todoist's incremental delta, so `poll.ts`'s cursor handling — including deferring the
 *   token write until jobs are queued — is genuinely exercised.
 * - **Per-command sync status.** `project_move` reports failure in the body with HTTP 200,
 *   which is the case `moveProject` exists to catch.
 *
 * Installed by handing the SDK a `customFetch` that goes through the global `fetch` msw
 * patches — see `server/todoist/transport.ts` for why that indirection is required.
 */
export class TodoistSimulator extends Simulator {
  tasks: ItemSyncView[] = []
  projects: PersonalProjectSyncView[] = []

  readonly deletedTaskIds = new Set<string>()
  readonly archivedProjectIds = new Set<string>()

  /** Entity id → the version at which it last changed. Drives `/sync` deltas. */
  private versions = new Map<string, number>()
  private clock = 0

  /** The set of API keys that authorize requests. */
  private apiKeys = new Set<string>()

  constructor() {
    super()
    this.installTransport()
  }

  override reset(): void {
    this.tasks = []
    this.projects = []
    this.deletedTaskIds.clear()
    this.archivedProjectIds.clear()
    this.versions.clear()
    this.clock = 0

    this.apiKeys = new Set([TODOIST_TEST_API_KEY])

    this.installTransport()
  }

  addProjects(projects: DeepPartial<PersonalProjectSyncView>[]): PersonalProjectSyncView[] {
    const created = projects.map((project) => deepMerge(defaultProject(), project))
    for (const project of created) {
      this.projects.push(project)
      this.bump(project.id)
    }
    return created
  }

  addTasks(tasks: DeepPartial<ItemSyncView>[]): ItemSyncView[] {
    const created = tasks.map((task) => deepMerge(defaultTask(), task))
    for (const task of created) {
      this.tasks.push(task)
      this.bump(task.id)
    }
    return created
  }

  task(id: string): ItemSyncView | undefined {
    return this.tasks.find((task) => task.id === id)
  }

  project(id: string): PersonalProjectSyncView | undefined {
    return this.projects.find((project) => project.id === id)
  }

  /**
   * Archives a project the way Todoist really does: the whole sub-tree, every `parent_id`
   * cleared. Both verified against the live API.
   *
   * Public so a test can seed an already-archived state without reaching for the raw fields
   * and accidentally modelling something Todoist never produces — a project that is archived
   * but still carries a parent, say, which would make it findable by walking the tree when
   * in reality it is not.
   */
  archive(id: string): void {
    const project = this.project(id)
    if (!project) throw new Error(`No such project in simulator: ${id}`)

    for (const target of [project, ...this.descendantsOf(project.id)]) {
      target.is_archived = true
      target.parent_id = null
      this.archivedProjectIds.add(target.id)
      this.touch(target)
    }
  }

  /** Every project beneath `id`, at any depth — what an archive cascades over. */
  private descendantsOf(id: string): PersonalProjectSyncView[] {
    const collected: PersonalProjectSyncView[] = []
    const queue = [id]
    const seen = new Set<string>([id])

    while (queue.length > 0) {
      const parentId = queue.shift()
      for (const child of this.projects.filter((p) => p.parent_id === parentId)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        collected.push(child)
        queue.push(child.id)
      }
    }

    return collected
  }

  protected handlers(): RequestHandler[] {
    return [
      // ---- User -------------------------------------------------------------------
      http.get(`${API}/user`, ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        return HttpResponse.json(currentUser())
      }),

      // ---- Projects -------------------------------------------------------------
      http.get(`${API}/projects`, ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const live = this.projects.filter((p) => !p.is_deleted && !p.is_archived)
        return this.page(request, live)
      }),

      /**
       * Archived projects are absent from `GET /projects` entirely, so this endpoint is the
       * only way to tell an archive from a deletion — which is what lets the mirror treat
       * the first as "completed" and the second as "rebuild it".
       */
      http.get(`${API}/projects/archived`, ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const archived = this.projects.filter((p) => !p.is_deleted && p.is_archived)
        return this.page(request, archived)
      }),

      http.post(`${API}/projects`, async ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const body = (await request.json()) as Record<string, unknown>
        const project = defaultProject()
        if (typeof body.name === 'string') project.name = body.name
        if (typeof body.parent_id === 'string') project.parent_id = body.parent_id

        this.projects.push(project)
        this.bump(project.id)
        return HttpResponse.json(project)
      }),

      /**
       * Archives the project **and its whole sub-tree**, clearing every `parent_id` on the
       * way — both verified against the live API. The nulled parent is the important part:
       * it means an archived project cannot be found by walking down from a root, so the
       * only way to recognise one is by id through `GET /projects/archived`.
       */
      http.post(`${API}/projects/:id/archive`, ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const project = this.project(String(params.id))
        if (!project) return notFound('Project')

        this.archive(project.id)
        return HttpResponse.json(project)
      }),

      /**
       * Unarchives **only** the named project, and does **not** restore its `parent_id` —
       * also verified live. So an unarchived project reappears at the top level, outside the
       * mirrored tree, and the caller has to move it back itself.
       */
      http.post(`${API}/projects/:id/unarchive`, ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const project = this.project(String(params.id))
        if (!project) return notFound('Project')

        project.is_archived = false
        this.archivedProjectIds.delete(project.id)
        this.touch(project)
        return HttpResponse.json(project)
      }),

      http.post(`${API}/projects/:id`, async ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const project = this.project(String(params.id))
        if (!project) return notFound('Project')

        const body = (await request.json()) as Record<string, unknown>
        if (typeof body.name === 'string') project.name = body.name

        this.touch(project)
        return HttpResponse.json(project)
      }),

      // ---- Tasks ----------------------------------------------------------------
      http.get(`${API}/tasks`, ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        return this.page(
          request,
          this.tasks.filter((task) => !task.is_deleted && !task.checked),
        )
      }),

      http.post(`${API}/tasks`, async ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const body = (await request.json()) as Record<string, unknown>
        const task = defaultTask()
        if (typeof body.content === 'string') task.content = body.content
        if (typeof body.description === 'string') task.description = body.description
        if (typeof body.project_id === 'string') task.project_id = body.project_id

        this.tasks.push(task)
        this.bump(task.id)
        return HttpResponse.json(task)
      }),

      http.get(`${API}/tasks/:id`, ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const task = this.task(String(params.id))
        if (!task || task.is_deleted) return notFound('Task')
        return HttpResponse.json(task)
      }),

      http.post(`${API}/tasks/:id/close`, ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const task = this.task(String(params.id))
        if (!task) return notFound('Task')

        task.checked = true
        task.completed_at = new Date().toISOString()
        this.touch(task)
        return new HttpResponse(null, { status: 204 })
      }),

      http.post(`${API}/tasks/:id/reopen`, ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const task = this.task(String(params.id))
        if (!task) return notFound('Task')

        task.checked = false
        task.completed_at = null
        this.touch(task)
        return new HttpResponse(null, { status: 204 })
      }),

      http.post(`${API}/tasks/:id`, async ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const task = this.task(String(params.id))
        if (!task) return notFound('Task')

        const body = (await request.json()) as Record<string, unknown>
        if (typeof body.content === 'string') task.content = body.content
        if (typeof body.description === 'string') task.description = body.description

        this.touch(task)
        return HttpResponse.json(task)
      }),

      http.delete(`${API}/tasks/:id`, ({ request, params }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const task = this.task(String(params.id))
        if (!task) return notFound('Task')

        // Soft delete, as Todoist does: the tombstone is what the next /sync reports.
        task.is_deleted = true
        this.deletedTaskIds.add(task.id)
        this.touch(task)
        return new HttpResponse(null, { status: 204 })
      }),

      // ---- Sync -----------------------------------------------------------------
      http.post(`${API}/sync`, async ({ request }) => {
        const denied = this.authorize(request)
        if (denied) return denied

        const body = (await request.json()) as {
          sync_token?: string
          resource_types?: string[]
          commands?: SyncCommand[]
        }

        const syncStatus = this.runCommands(body.commands ?? [])

        const since = body.sync_token === '*' || !body.sync_token ? -1 : Number(body.sync_token)
        const from = Number.isNaN(since) ? -1 : since

        const response: Record<string, unknown> = {
          sync_token: String(this.clock),
          full_sync: from === -1,
        }

        if (Object.keys(syncStatus).length > 0) response.sync_status = syncStatus

        if (body.resource_types?.includes('items')) {
          response.items = this.tasks.filter((task) => (this.versions.get(task.id) ?? 0) > from)
        }
        if (body.resource_types?.includes('projects')) {
          response.projects = this.projects.filter(
            (project) => (this.versions.get(project.id) ?? 0) > from,
          )
        }

        return HttpResponse.json(response)
      }),
    ]
  }

  private runCommands(commands: SyncCommand[]): Record<string, 'ok' | Record<string, unknown>> {
    const status: Record<string, 'ok' | Record<string, unknown>> = {}

    for (const command of commands) {
      if (command.type !== 'project_move') {
        status[command.uuid] = syncError(`Unsupported command "${command.type}"`)
        continue
      }

      const id = command.args?.id ?? ''
      const parentId = command.args?.parent_id ?? null
      const project = this.project(id)

      if (!project) {
        status[command.uuid] = syncError(`Project ${id} not found`)
        continue
      }
      if (parentId !== null && !this.project(parentId)) {
        status[command.uuid] = syncError(`Parent ${parentId} not found`)
        continue
      }

      project.parent_id = parentId
      this.touch(project)
      status[command.uuid] = 'ok'
    }

    return status
  }

  private installTransport(): void {
    setTodoistTransport({ customFetch: mswFetch })
  }

  private bump(id: string): void {
    this.versions.set(id, ++this.clock)
  }

  /** Records a change: new version for `/sync`, and a strictly newer `updated_at`. */
  private touch(entity: { id: string; updated_at?: string | null }): void {
    this.bump(entity.id)

    const now = Date.now()
    const previous = entity.updated_at ? Date.parse(entity.updated_at) : Number.NaN
    entity.updated_at = new Date(
      Number.isNaN(previous) ? now : Math.max(now, previous + 1),
    ).toISOString()
  }

  private authorize(request: Request): Response | null {
    const header = request.headers.get('Authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''

    if (!this.apiKeys.has(token)) {
      return HttpResponse.json({ error: 'Invalid token' }, { status: 401 })
    }
    return null
  }

  /** Todoist's `{ results, next_cursor }` list envelope. */
  private page<T>(request: Request, items: T[]): Response {
    const query = new URL(request.url).searchParams
    const limit = Number(query.get('limit') ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE
    const start = Number(query.get('cursor') ?? 0) || 0
    const end = start + limit

    return HttpResponse.json({
      results: items.slice(start, end),
      next_cursor: end < items.length ? String(end) : null,
    })
  }
}

/**
 * Routes the SDK through the global `fetch` (which msw patches) and adapts the result to
 * the `CustomFetchResponse` shape the SDK expects.
 */
const mswFetch: CustomFetch = async (url, options) => {
  const { timeout: _timeout, ...init } = options ?? {}
  const response = await globalThis.fetch(url, init)
  const body = await response.text()

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(body === '' ? undefined : JSON.parse(body)),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
  }
}

function notFound(entity: string): Response {
  return HttpResponse.json({ error: `${entity} not found` }, { status: 404 })
}

function syncError(message: string): Record<string, unknown> {
  return {
    error: message,
    error_code: 400,
    error_extra: {},
    error_tag: 'COMMAND_FAILED',
    http_code: 400,
  }
}

/** A minimal `GET /user` response — just enough to satisfy the SDK's `CurrentUserSchema`. */
function currentUser(): Record<string, unknown> {
  return {
    id: 'user-1',
    email: 'user@example.com',
    full_name: 'Test User',
    avatar_big: null,
    avatar_medium: null,
    avatar_s640: null,
    avatar_small: null,
    business_account_id: null,
    is_premium: false,
    premium_status: 'not_premium',
    date_format: 0,
    time_format: 0,
    weekly_goal: 0,
    daily_goal: 0,
    completed_count: 0,
    completed_today: 0,
    karma: 0,
    karma_trend: 'stable',
    lang: 'en',
    next_week: 1,
    start_day: 1,
    start_page: 'inbox',
    tz_info: { gmt_string: 'UTC', hours: 0, is_dst: 0, minutes: 0, timezone: 'UTC' },
    inbox_project_id: 'td-project-inbox',
    days_off: [],
    weekend_start_day: 6,
  }
}

function defaultProject(): PersonalProjectSyncView {
  const n = nextSequence('todoist-project')
  const now = new Date().toISOString()
  return {
    id: `td-project-${n}`,
    can_assign_tasks: true,
    can_comment: true,
    child_order: n,
    is_collapsed: false,
    color: 'charcoal',
    creator_uid: 'user-1',
    created_at: now,
    is_archived: false,
    is_deleted: false,
    is_favorite: false,
    is_frozen: false,
    name: `Todoist Project ${n}`,
    is_shared: false,
    updated_at: now,
    view_style: 'list',
    default_order: 0,
    description: '',
    public_key: '',
    access: null,
    role: null,
    parent_id: null,
    inbox_project: false,
  }
}

function defaultTask(): ItemSyncView {
  const n = nextSequence('todoist-task')
  const now = new Date().toISOString()
  return {
    user_id: 'user-1',
    id: `td-task-${n}`,
    project_id: 'td-project-1',
    section_id: null,
    parent_id: null,
    added_by_uid: 'user-1',
    assigned_by_uid: null,
    responsible_uid: null,
    labels: [],
    deadline: null,
    duration: null,
    is_collapsed: false,
    checked: false,
    is_deleted: false,
    added_at: now,
    completed_at: null,
    completed_by_uid: null,
    updated_at: now,
    due: null,
    priority: 1,
    child_order: n,
    content: `Task ${n}`,
    description: '',
    note_count: 0,
    day_order: -1,
    completed_count: 0,
    postponed_count: 0,
  }
}
