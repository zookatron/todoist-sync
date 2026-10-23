import { db } from '../../db/index.js'
import { glassfrogIntegration, todoistIntegration } from '../../db/schema/integrations.js'
import { locks } from '../../db/schema/locks.js'
import { projectMapping, syncLog, taskMapping, user } from '../../db/schema/index.js'
import { contentHash, type TaskSnapshot } from '../../sync/resolve.js'
import { GLASSFROG_TEST_API_KEY, ME_ACTOR_ID } from '../glassfrog.js'
import { TODOIST_TEST_API_KEY } from '../todoist.js'
import { Factory, FactoryContext } from './factory.js'
import { nextSequence } from './sequence.js'

type User = typeof user.$inferSelect
type TodoistIntegration = typeof todoistIntegration.$inferSelect
type GlassfrogIntegration = typeof glassfrogIntegration.$inferSelect
type ProjectMapping = typeof projectMapping.$inferSelect
type TaskMapping = typeof taskMapping.$inferSelect
type SyncLog = typeof syncLog.$inferSelect
type Lock = typeof locks.$inferSelect

/**
 * Resolves the user for a relation.
 *
 * Every other table cascades from `user`, so nothing can be inserted before one exists.
 * Going through the shared context means a graph built from one context hangs off a single
 * user rather than sprouting a new one per row.
 */
async function userIdFrom(context: FactoryContext): Promise<string> {
  return (await new UserFactory(context).findFromContextOrMake()).id
}

export class UserFactory extends Factory<User> {
  protected defaults(): Partial<User> {
    const n = nextSequence('user')
    return {
      id: `user-${n}`,
      name: `Test User ${n}`,
      email: `user-${n}@example.com`,
      emailVerified: true,
    }
  }

  protected async builder(data: User): Promise<User> {
    const [row] = await db.insert(user).values(data).returning()
    return row as User
  }
}

export class TodoistIntegrationFactory extends Factory<TodoistIntegration> {
  protected defaults(): Partial<TodoistIntegration> {
    return {
      apiKey: TODOIST_TEST_API_KEY,
      rootTodoistProjectId: null,
      todoistSyncToken: null,
    }
  }

  protected async builder(data: TodoistIntegration): Promise<TodoistIntegration> {
    const [row] = await db.insert(todoistIntegration).values(data).returning()
    return row as TodoistIntegration
  }

  withUser(): this {
    return this.override(async () => ({ userId: await userIdFrom(this.context) }))
  }

  /** The Todoist project the mirrored tree hangs under. */
  withRoot(rootTodoistProjectId: string): this {
    return this.override({ rootTodoistProjectId })
  }

  withSyncToken(todoistSyncToken: string): this {
    return this.override({ todoistSyncToken })
  }
}

export class GlassfrogIntegrationFactory extends Factory<GlassfrogIntegration> {
  protected defaults(): Partial<GlassfrogIntegration> {
    return { apiKey: GLASSFROG_TEST_API_KEY, actorId: ME_ACTOR_ID }
  }

  protected async builder(data: GlassfrogIntegration): Promise<GlassfrogIntegration> {
    const [row] = await db.insert(glassfrogIntegration).values(data).returning()
    return row as GlassfrogIntegration
  }

  withUser(): this {
    return this.override(async () => ({ userId: await userIdFrom(this.context) }))
  }

  /** A row saved before the actor id was stored; the first poll reads it from `/me`. */
  withoutActorId(): this {
    return this.override({ actorId: null })
  }
}

export class ProjectMappingFactory extends Factory<ProjectMapping> {
  protected defaults(): Partial<ProjectMapping> {
    const n = nextSequence('project-mapping')
    return {
      kind: 'role',
      glassfrogId: `role-${n}`,
      todoistProjectId: `td-project-${n}`,
      parentGlassfrogId: null,
    }
  }

  protected async builder(data: ProjectMapping): Promise<ProjectMapping> {
    const [row] = await db.insert(projectMapping).values(data).returning()
    return row as ProjectMapping
  }

  withUser(): this {
    return this.override(async () => ({ userId: await userIdFrom(this.context) }))
  }

  forRole(glassfrogId: string, todoistProjectId: string): this {
    return this.override({ kind: 'role', glassfrogId, todoistProjectId })
  }

  forProject(glassfrogId: string, todoistProjectId: string, parentGlassfrogId: string): this {
    return this.override({ kind: 'project', glassfrogId, todoistProjectId, parentGlassfrogId })
  }
}

export class TaskMappingFactory extends Factory<TaskMapping> {
  protected defaults(): Partial<TaskMapping> {
    return {
      glassfrogActionId: null,
      todoistTaskId: null,
      glassfrogUpdatedAt: null,
      todoistUpdatedAt: null,
      contentHash: null,
    }
  }

  protected async builder(data: TaskMapping): Promise<TaskMapping> {
    const [row] = await db.insert(taskMapping).values(data).returning()
    return row as TaskMapping
  }

  withUser(): this {
    return this.override(async () => ({ userId: await userIdFrom(this.context) }))
  }

  /** A task already paired across both systems. */
  linked(glassfrogActionId: string, todoistTaskId: string): this {
    return this.override({ glassfrogActionId, todoistTaskId })
  }

  /**
   * Records the state the last sync converged on.
   *
   * Storing the hash is half of the ping-pong defence: without it, our own write reads
   * back as a remote change on the next poll.
   */
  converged(snapshot: Omit<TaskSnapshot, 'updatedAt'>, at = new Date()): this {
    return this.override({
      // `contentHash` ignores timestamps by design — that is what lets it tell a real
      // edit from an echo of our own write — so the caller supplies the time separately.
      contentHash: contentHash({ ...snapshot, updatedAt: at }),
      glassfrogUpdatedAt: at,
      todoistUpdatedAt: at,
      lastSyncedAt: at,
    })
  }
}

export class SyncLogFactory extends Factory<SyncLog> {
  protected defaults(): Partial<SyncLog> {
    return { description: `Log entry ${nextSequence('sync-log')}`, metadata: null }
  }

  protected async builder(data: SyncLog): Promise<SyncLog> {
    const [row] = await db.insert(syncLog).values(data).returning()
    return row as SyncLog
  }

  withUser(): this {
    return this.override(async () => ({ userId: await userIdFrom(this.context) }))
  }
}

export class LockFactory extends Factory<Lock> {
  protected defaults(): Partial<Lock> {
    const n = nextSequence('lock')
    return {
      key: `lock-${n}`,
      owner: `owner-${n}`,
      expiresAt: new Date(Date.now() + 60_000),
    }
  }

  protected async builder(data: Lock): Promise<Lock> {
    const [row] = await db.insert(locks).values(data).returning()
    return row as Lock
  }

  /** Already expired, so another caller is entitled to steal it. */
  expired(): this {
    return this.override({ expiresAt: new Date(Date.now() - 60_000) })
  }
}

export type ConnectedUser = {
  user: User
  todoist: TodoistIntegration
  glassfrog: GlassfrogIntegration
  /** The Todoist project id the mirrored hierarchy hangs under. */
  rootProjectId: string
}

/**
 * A user with both integrations connected and a root project chosen.
 *
 * The starting point for nearly every end-to-end test: below this, the sync jobs bail out
 * with `not-configured` before reaching anything worth testing.
 */
export async function connectedUser(
  options: { rootProjectId?: string; context?: FactoryContext } = {},
): Promise<ConnectedUser> {
  const context = options.context ?? new FactoryContext()
  const rootProjectId = options.rootProjectId ?? 'td-root'

  const created = await new UserFactory(context).make()
  const todoist = await new TodoistIntegrationFactory(context)
    .withUser()
    .withRoot(rootProjectId)
    .make()
  const glassfrog = await new GlassfrogIntegrationFactory(context).withUser().make()

  return { user: created, todoist, glassfrog, rootProjectId }
}
