# Architecture

## Processes

Two processes share one codebase and one database:

| Process | Entry                         | Responsibility                                                  |
| ------- | ----------------------------- | --------------------------------------------------------------- |
| Web     | `react-router-serve` → `app/` | UI, auth, tRPC API                                              |
| Worker  | `worker/index.ts`             | BullMQ scheduler + job execution. **All syncing happens here.** |

Shared logic lives in `server/`, outside `app/`, so the worker can import it without dragging in
React Router's route-module graph. Both reach it through the `@server/*` alias.

## Data flow

```
                        every SYNC_INTERVAL_MS (default 1h)
                                     │
                          ┌──────────▼───────────┐
                          │  sync-poll job       │   lock: poll:{userId}
                          └──────────┬───────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
    1. hierarchy pass       2. Todoist delta       3. Glassfrog delta
      (both ways)             api.sync(token)      enumerate /me/actions
              │              → changed + deleted    → compare updated_at
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                                     │
                         one sync-task job per changed task
                    (taskJobKey collapses both-sides changes)
                                     │
                          ┌──────────▼───────────┐
                          │  sync-task job       │   lock: task:{userId}:{key}
                          │  resolve() → apply   │   fails if already held
                          └──────────────────────┘
```

The hierarchy pass runs **first** so that per-task jobs always find their destination project.

## Change detection

The two APIs are asymmetric, and the design follows that asymmetry:

**Todoist** supports real incremental sync. `api.sync({ syncToken, resourceTypes: ['items'] })`
returns only the tasks that changed since the last token, including deletions
(`isDeleted: true`). One call per poll. The new token is persisted **after** the resulting jobs
are enqueued, so a crash re-delivers rather than silently skips.

Project changes are deliberately **not** read from that delta. The hierarchy pass enumerates
instead — `GET /projects` plus `GET /projects/archived` — because enumeration is idempotent: it
produces the same answer however many times it runs, and it survives a lost or reset sync token.
A one-shot event stream cannot say "this project is archived and has been for a week", which is
exactly the question reconciliation asks.

**Glassfrog** does not. The v5 API has no org-wide action list and no `updated_since` filter, so
there is nothing to be incremental against. Detection is enumerate-and-diff: page through
`/me/actions` and compare each `updated_at` against the stored mapping. A mapped action that is
_absent_ from the enumeration was deleted or moved out of scope. Limiting scope to your own roles
(`/me/*`) keeps this to roughly one page per poll.

### Whose items are mine

v5 attributes actions and projects to a **role**, so a co-filler's items on a shared role arrive
in `/me/actions` and `/roles/{id}/projects` too. Only the legacy **v3** API records a person
(`links.person`). `server/sync/ownership.ts` decides:

- An item is mine if v3 lists me as its owner (`links.person`). **A v3 API key is required** —
  there is no fallback, because without v3 there is no telling whose items are whose. A user
  with no v3 key saved (including anyone who connected before it was required) has sync paused:
  `runPoll` skips them with a warning until they add it in settings, where both keys are saved
  together.
- v5 returns each resource's v3 id as `legacy_id` when asked (`include_legacy_id=true`), which is
  the join. My v3 person id is the v5 actor's `legacy_id` (`/me?include_legacy_id=true`),
  captured when the v5 key is saved. The vendored v5 spec documents the param for roles, actors
  and `/me` only, though the API honours it everywhere, so `openapi-ts.glassfrog.config.ts` adds it
  to the other endpoints and schemas at generation time (`parser.patch`). It retires with v3.
- **Owners are cached in Redis** as v5 id → v3 person id (`glassfrog:owner:<v5 id>`, 10-day TTL;
  `none` for an item v3 says nobody owns), and checked before the owner is attached to the v5
  data. Ownership is assumed to rarely change, so a cached entry is never re-checked; a
  reassignment is noticed when the entry expires. Nothing is cached in process.
- Items not yet cached are looked up in v3: one request each for up to 5, else one paged list
  of the whole organization. In steady state that is a single `MGET` and no v3 requests. An
  action created from Todoist has its owner recorded immediately, saving the lookup.
- A slow or unreachable Redis (2s) falls back to asking v3 every time.
- Not-mine actions are dropped before the diff, so a mapped one reads as absent and its Todoist
  task is removed; `sync-task` also treats a not-mine action as gone. The Glassfrog action is
  never touched. Not-mine projects are pruned from the desired tree, except ancestors of mine.

## Hierarchy mapping

```
Todoist root project (user-selected)
└── Role project              ← Glassfrog role you fill (/me/roles). Glassfrog only.
    ├── Project               ↔ Glassfrog project owned by that role
    │   └── Sub-project       ↔ recursive via /projects/{id}/sub_projects
    └── (tasks)               ← actions on the role with no parent project
```

A project created anywhere inside a role project — at any depth — becomes a Glassfrog project on
the next poll. A role project can only appear because Glassfrog has that role.

The diff is a pure function of (Glassfrog tree, Todoist tree, stored mappings) producing
operations; only the apply step performs I/O. It is **two-way, but not symmetrically so**:

| Thing              | Direction                                                      |
| ------------------ | -------------------------------------------------------------- |
| Roles              | Glassfrog only — never created, renamed or closed from Todoist |
| Project existence  | Both ways                                                      |
| Project completion | Both ways                                                      |
| Project name       | Both ways (projects); Glassfrog wins for roles                 |
| Project placement  | Glassfrog only                                                 |
| Project deletion   | Glassfrog only — a deleted mirror is rebuilt                   |

Every mapped pair falls into exactly one row of this table, which is the whole policy:

| Glassfrog node        | Todoist project       | Operation                                                       |
| --------------------- | --------------------- | --------------------------------------------------------------- |
| active                | present, not archived | rename / move as needed                                         |
| active, project       | present, archived     | newer side wins: complete in Glassfrog, or unarchive in Todoist |
| active, role          | present, archived     | unarchive in Todoist                                            |
| active                | absent                | recreate in Todoist                                             |
| completed             | present, archived     | nothing — both sides agree                                      |
| completed, project    | present, not archived | newer side wins: reopen in Glassfrog, or archive in Todoist     |
| completed             | absent                | drop the mapping                                                |
| absent from Glassfrog | present, not archived | archive in Todoist, drop the mapping                            |
| absent from Glassfrog | present, archived     | drop the mapping                                                |
| absent from Glassfrog | absent                | drop the mapping                                                |

An unmapped Glassfrog node is created in Todoist when active. An unmapped Todoist project is
adopted into Glassfrog when it is live and sits under a mapped role or project — a chain of new
projects is adopted outermost-first, so each one's parent exists by the time it is applied. One
sitting **directly under the root** is left alone: only a role can live there, and roles come
from Glassfrog.

Archiving is used rather than deleting throughout, so a mistake is recoverable in Todoist.

### Archive means completed

Archiving a mirrored Todoist project sets its Glassfrog project to `completed`; unarchiving sets
it back to `current`. Two consequences worth knowing:

- Glassfrog's **open actions on a completed project are left alone**. Their Todoist tasks were
  archived along with the project and stay content-converged, so nothing is lost — but those
  actions still need finishing by hand in Glassfrog. The sync says so in the activity feed.
- A mapping row **survives completion as a tombstone**. That is what makes a later unarchive a
  reopen instead of a second Glassfrog project, and it is why `drop-mapping` is driven by "gone
  from both sides" rather than "gone from Todoist".

Four Todoist behaviours shape this, all verified against the live API rather than assumed:

| What Todoist does on archive/unarchive                                 | Why it matters                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Archiving removes the project from `GET /projects`                     | `GET /projects/archived` is the only way to tell archived from deleted                                                                     |
| Archiving **clears `parent_id`**                                       | An archived project is unreachable from the root, so it must be matched by **id** through the mapping table, never by position in the tree |
| Archiving **cascades** to the whole sub-tree                           | Each descendant appears in the archived listing in its own right, so a sub-tree completes together with nothing inferred                   |
| Unarchiving does **not** restore `parent_id`, and does **not** cascade | An unarchived project reappears at the top level, outside the mirror, so the sync moves it back in the same pass                           |

The second and fourth are the load-bearing ones. Looking for an archived project by walking down
from the root finds nothing, which reads as a deletion — so the mirror rebuilds the project
instead of completing it. And because an unarchived project lands outside the root, **mapped**
projects are resolved against an account-wide listing while **unmapped** ones are only ever
discovered inside the root subtree. That split is what stops a project the user brings back from
being treated as deleted and duplicated.

### Who wins a disagreement

Name and completion status both resolve by comparing the two sides' live `updated_at`, newer
wins, with an exact tie going to Glassfrog. Nothing is stored for this: a write that makes the
two sides agree suppresses its own echo, which is the same mechanism task content relies on.

Roles are the exception, for an API reason rather than a design one — Glassfrog's `Role` carries
no timestamp at all, so there is nothing to compare and Glassfrog simply wins.

The known imprecision: any Glassfrog project edit bumps `updated_at`, including ones that touch
neither the name nor the status. An unrelated Glassfrog edit landing after a Todoist rename will
therefore revert that rename. This is the same trade-off the task sync already makes.

## Task mapping

| Glassfrog Action                 | Todoist Task       |
| -------------------------------- | ------------------ |
| `description`                    | `content`          |
| `note`                           | `description`      |
| `status: completed`              | `checked: true`    |
| `status: cancelled` / `archived` | task deleted       |
| `role_id` / `parent_project_id`  | containing project |

Conflicts resolve by comparing `updated_at` on both sides — the more recently modified side wins
and overwrites the other.

### Placement is one-way

Content is two-way, but _which project a task sits in_ is Glassfrog's call alone. Every task sync
compares the task's current Todoist project with the one its action maps to, and a mismatch
rebuilds the task in the right place: add the replacement, repoint the `task_mapping` row, then
delete the stale copy.

What this exists for now is a task **dragged between mirrored projects** in Todoist. Without the
check its content still agrees with Glassfrog, so `resolve` returns `already-converged` and the
task quietly stays where it was dropped.

It used to also cover a **task stranded in an archived project**: archiving a Todoist project drops
it out of `GET /projects`, the hierarchy pass saw the mapping pointing at nothing and recreated the
project empty, and the tasks inside were left addressable by id but invisible. That no longer
happens — the hierarchy pass reads archived projects too, so an archived role project is unarchived
in place and an archived project mirror means "completed" rather than "rebuild it". The placement
check is kept for the drag case, not for this one.

Two consequences worth knowing:

- Dragging a task between mirrored projects in Todoist is **reverted** on the next poll. Move the
  action's role or parent project in Glassfrog instead.
- The rebuild is an add plus a delete, not a move, so Todoist-only extras on the task (comments,
  subtasks, labels) do not survive it. Placement is only corrected when it is actually wrong.

An unknown destination is never treated as a mismatch: if the action has no mapped project yet, the
task is left alone until the hierarchy pass creates one.

### Deletion is one-way

Glassfrog is the system of record, so deletion only travels Glassfrog → Todoist:

| What happened                              | What the sync does                                  |
| ------------------------------------------ | --------------------------------------------------- |
| Action deleted, cancelled or archived      | The linked Todoist task is deleted, mapping dropped |
| Task deleted in Todoist, action still live | The task is **re-created** from the action's data   |

Re-creation reuses the existing `task_mapping` row, repointing it at the new Todoist task id, so
the rebuilt task is not mistaken for a brand-new one on the next poll. The task reappears in the
project its action currently maps to, which may differ from where it was deleted.

To make a task go away for good, delete or cancel the action in Glassfrog.

## Concurrency

A single generic lock utility (`server/utils/lock.ts`) backed by a `locks` table, acquired with one
atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at < now()`. A row comes back only if
the caller won.

It is used for two distinct jobs:

1. `poll:{userId}` — a slow poll must not overlap the next tick. Contention is normal; the job
   exits cleanly.
2. `task:{userId}:{key}` — two jobs must never sync the same task at once. Contention is an
   error; the job **fails** and BullMQ retries with backoff.

Locks carry a TTL and an owner. Only the owner can release one, and an expired lock can be stolen,
so a crashed worker cannot deadlock the system.

## Credentials

Both integrations authenticate with a static, long-lived personal token: a Todoist API token and
a Glassfrog API v5 key and a v3 key (used for ownership), each pasted into the dashboard and stored in plaintext in the database.
Neither expires, carries scopes, or needs to be refreshed — `getTodoistApi()`/`callTodoist()` and
`getGlassfrogClient()` just read the stored token and build a client from it.

## Avoiding sync ping-pong

Writing to either API bumps that record's `updated_at`, so the next poll sees our own write as a
change. Two defenses, both required:

1. After every write, re-read the resulting timestamp and store it in `task_mapping`.
2. Store a `contentHash` of the normalized field set. A delta whose hash matches the stored one is
   our own echo and is dropped.

Without both, the two systems would overwrite each other forever.
