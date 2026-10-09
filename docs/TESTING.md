# Testing

The suite needs **no Postgres, no Redis, and no network**. `yarn test` passes with
`docker compose down`. Anything that reaches for a real service is a bug in the test setup,
and is designed to fail loudly rather than quietly succeed.

## The idea

Most of this codebase's risk lives in functions that interleave Postgres, two HTTP APIs and
a lock — `runTaskSync`, `syncHierarchy`, `runPoll`. Testing those with `vi.mock` replaces
the exact layer where their bugs live; extracting more pure functions distorts the design.

So instead the _process boundary_ is replaced with stateful in-memory doubles:

| Boundary  | Stand-in             | What it really is                                      |
| --------- | -------------------- | ------------------------------------------------------ |
| Postgres  | `DatabaseSimulator`  | PGlite — real Postgres (WASM), real migrations         |
| Glassfrog | `GlassfrogSimulator` | In-memory entities behind msw handlers                 |
| Todoist   | `TodoistSimulator`   | Same, plus a sync-token version clock                  |
| BullMQ    | `QueueSimulator`     | Records `add()` calls                                  |
| Redis     | `RedisSimulator`     | In-memory `MGET` / pipelined `SET … EX`, TTLs recorded |

Code under test runs **unmodified and unmocked**. A test reads: seed both worlds, run the
real function, assert on both worlds afterwards.

## Writing a test

Instantiate simulators at the **top level** of the file — their constructors register the
vitest hooks. Each file gets its own isolated database, so files run in parallel.

```ts
import {
  connectedUser,
  DatabaseSimulator,
  GlassfrogSimulator,
  TodoistSimulator,
} from '@server/testing/index.js'

new DatabaseSimulator()
const glassfrog = new GlassfrogSimulator()
const todoist = new TodoistSimulator()

let userId: string
beforeEach(async () => {
  userId = (await connectedUser({ rootProjectId: 'td-root' })).user.id
})

it('mirrors a role into Todoist', async () => {
  glassfrog.addRoles([{ id: 'role-eng', name: 'Engineering' }])
  todoist.addProjects([{ id: 'td-root', name: 'Glassfrog' }])

  await syncHierarchy(userId)

  expect(todoist.projects.map((p) => p.name)).toContain('Engineering')
})
```

Everything resets between tests: tables are truncated, simulator state is cleared, and the
`user-1`/`role-1` sequence counters restart. Nothing leaks from one test to the next.

`connectedUser()` is the usual starting point — a user with both integrations and a root
project. Below that, the sync jobs bail out with `not-configured` before reaching anything
worth testing.

### Still write pure unit tests

`resolve.ts`, `hierarchy-diff.ts` and the two `delta.ts` files take plain data and return
decisions. Test those directly — they need none of this machinery, and the CLAUDE.md rule
that keeps them pure is worth protecting.

## Factories

One per table, in `server/testing/factories/entities.ts`. Chainable modifiers describe
_state that matters_, not column values:

```ts
await new TodoistIntegrationFactory().withUser().withRoot('td-root').make()
await new TaskMappingFactory().withUser().linked('action-1', 'td-task-1').converged(snapshot).make()
await new ProjectMappingFactory().override({ userId }).forRole('role-eng', 'td-eng').make()
```

`make(n)` builds several. `override()` takes a partial or a (possibly async) function.
`after()` runs once the row exists, for follow-ups needing its generated id.

**Sharing relations.** Factories that share a `FactoryContext` resolve `withUser()` to the
_same_ user rather than creating one each:

```ts
const context = new FactoryContext()
const user = await new UserFactory(context).make()
await new TodoistIntegrationFactory(context).withUser().make() // reuses `user`
await new GlassfrogIntegrationFactory(context).withUser().make() // reuses `user`
```

Note `user` must exist first — every other table cascades from it.

### Adding a factory

Extend `Factory<T>` with `defaults()` (a complete, valid row) and `builder()` (the insert).
Use `nextSequence('name')` for ids so output stays deterministic — no faker. Then add a
modifier for each meaningful state, and export it from `server/testing/index.ts`.

## Simulators

### Seeding and inspecting

`addRoles` / `addProjects` / `addActions` / `addTasks` take **deep partials** over complete
defaults, so a test names only what it cares about. The stores (`glassfrog.actions`,
`todoist.projects`, …) are readable directly, and `todoist.deletedTaskIds` /
`glassfrog.deletedActionIds` / `todoist.archivedProjectIds` record what was destroyed.

### Injecting failures

`useForTest()` prepends handlers for the current test only — how error paths get exercised
without teaching the simulator to fail on demand:

```ts
todoist.useForTest([
  http.post('https://api.todoist.com/api/v1/projects', () =>
    HttpResponse.json({ error: 'boom' }, { status: 400 }),
  ),
])
```

Return `undefined` from a resolver to fall through to the simulator's own handler — useful
for failing only the first call:

```ts
let calls = 0
todoist.useForTest([http.post(url, () => (++calls === 1 ? HttpResponse.error() : undefined))])
```

msw matches the **first** handler, which is why overrides go in front.

### Adding an endpoint

1. Find the real request. For Glassfrog read the URL and verb out of
   `server/glassfrog/generated/sdk.gen.ts` — several are non-obvious (`createAction` is
   `POST /roles/{role_id}/actions`; action completion is a sub-resource, `POST` and `DELETE`
   on `/actions/{id}/completion`, but **project** completion is not — it is a status field on
   `PATCH /projects/{id}`, and creation is `POST /roles/{role_id}/projects`). For Todoist read
   the client in `node_modules/@doist/todoist-sdk/dist/esm/clients/`; note that archived
   projects have their own listing (`GET /projects/archived`) because `GET /projects` omits
   them entirely.
2. Add a handler in the simulator's `handlers()`, typed against the generated types.
3. **Answer in the wire format.** Todoist is snake_case (`ItemSyncView`,
   `PersonalProjectSyncView`); the SDK does the camelCase conversion and validates the
   result with zod, so a wrong shape fails loudly. Glassfrog list endpoints must return
   `{ data, meta: { pagination } }`.
4. If it mutates, call `this.touch(entity)` so `updated_at` advances — see below.

### Writing a simulator for a new API

Extend `Simulator`, implement `handlers()` and `reset()`. Registration, per-test reset and
teardown come from the base class. Generate types from the API's OpenAPI spec with
`@hey-api/openapi-ts` (vendor the spec into `openapi/`, mirroring the two existing
configs) so the simulator cannot drift from the published contract without the compiler
noticing.

## A behaviour that carries real weight

This exists because CLAUDE.md names it as the bug most likely to bite. It is _reproduced_,
not mocked, so the corresponding defence is genuinely tested.

**Writes bump `updated_at`.** Both simulators advance the timestamp on every write, and
guarantee it moves strictly forward even when two writes land in the same millisecond. So
our own write really does come back looking like a remote change on the next poll, and the
`contentHash` echo-suppression is what stops the ping-pong — see the ping-pong test in
`server/queue/jobs/sync-task.e2e.test.ts`.

Todoist's `/sync` deltas are modelled with a monotonic version counter: every mutation
stamps the next version, and a sync with token `N` returns only what changed after it. That
makes `poll.ts`'s cursor handling — including deferring the token write until jobs are
queued — genuinely exercised.

## Traps

**The Todoist SDK bypasses msw.** On Node it resolves npm-undici's own `fetch` with a
private dispatcher instead of calling `globalThis.fetch`, which is all `setupServer()`
patches. `server/todoist/transport.ts` exists solely so tests can inject a `customFetch`
that routes back through the global `fetch`. `TodoistSimulator` installs it automatically —
but if you add a new Todoist call path, make sure it goes through `callTodoist` or passes
`todoistTransport()`, or the request will silently reach the real API. Glassfrog needs no
such seam; the hey-api client uses global `fetch`.

**An unmodelled request fails the test.** msw runs with `onUnhandledRequest: 'error'`. If a
test fails with "intercepted a request without a matching request handler", add the handler
to the simulator — do not work around it.

**Simulators are per-file singletons.** Construct them at module scope, never inside
`beforeEach`, or you will register duplicate hooks.

**The production seams are inert by default.** `setDatabase`, `setTodoistTransport`,
`setTaskQueue`, `setPollQueue` and `setConnection` do nothing until a simulator sets them, and each restores
the real implementation on teardown. Never call them from application code.
