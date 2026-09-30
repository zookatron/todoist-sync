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
   (Glassfrog → Todoist)     api.sync(token)      enumerate /me/actions
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

**Todoist** supports real incremental sync. `api.sync({ syncToken, resourceTypes: ['items',
'projects'] })` returns only what changed since the last token, including deletions
(`isDeleted: true`). One call per poll. The new token is persisted **after** the resulting jobs
are enqueued, so a crash re-delivers rather than silently skips.

**Glassfrog** does not. The v5 API has no org-wide action list and no `updated_since` filter, so
there is nothing to be incremental against. Detection is enumerate-and-diff: page through
`/me/actions` and compare each `updated_at` against the stored mapping. A mapped action that is
_absent_ from the enumeration was deleted or moved out of scope. Limiting scope to your own roles
(`/me/*`) keeps this to roughly one page per poll.

## Hierarchy mapping

```
Todoist root project (user-selected)
└── Role project              ← Glassfrog role you fill (/me/roles)
    ├── Project               ← Glassfrog project owned by that role
    │   └── Sub-project       ← recursive via /projects/{id}/sub_projects
    └── (tasks)               ← actions on the role with no parent project
```

One-way, Glassfrog → Todoist. The diff is a pure function of (desired tree, actual tree) producing
`create` / `rename` / `move` / `orphan` operations; only the apply step performs I/O. Orphans —
Todoist projects under the root with no Glassfrog counterpart — are archived, not deleted, so a
mistake is recoverable.

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

The case this exists for is a **task stranded in an archived project**. Archiving a Todoist project
drops it out of `GET /projects`, so the hierarchy pass sees its mapping pointing at nothing and
recreates the project empty — leaving the tasks that were inside it addressable by id but invisible
in the app and outside the mirrored tree. Without a placement check their content still agrees with
Glassfrog, so `resolve` returns `already-converged` and they stay lost.

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
a Glassfrog API v5 key, each pasted into the dashboard and stored in plaintext in the database.
Neither expires, carries scopes, or needs to be refreshed — `getTodoistApi()`/`callTodoist()` and
`getGlassfrogClient()` just read the stored token and build a client from it.

## Avoiding sync ping-pong

Writing to either API bumps that record's `updated_at`, so the next poll sees our own write as a
change. Two defenses, both required:

1. After every write, re-read the resulting timestamp and store it in `task_mapping`.
2. Store a `contentHash` of the normalized field set. A delta whose hash matches the stored one is
   our own echo and is dropped.

Without both, the two systems would overwrite each other forever.
