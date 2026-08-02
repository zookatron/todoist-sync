# Architecture

## Processes

Two processes share one codebase and one database:

| Process | Entry                         | Responsibility                                                  |
| ------- | ----------------------------- | --------------------------------------------------------------- |
| Web     | `react-router-serve` → `app/` | UI, auth, tRPC API, Todoist OAuth callback                      |
| Worker  | `worker/index.ts`             | BullMQ scheduler + job execution. **All syncing happens here.** |

Shared logic lives in `server/`, outside `app/`, so the worker can import it without dragging in
React Router's route-module graph. Both reach it through the `@server/*` alias.

## Data flow

```
                        every SYNC_INTERVAL_MS (default 60s)
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
                        (jobId dedupes both-sides changes)
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

## Concurrency

A single generic lock utility (`server/lock.ts`) backed by a `locks` table, acquired with one
atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at < now()`. A row comes back only if
the caller won.

It is used for three distinct jobs:

1. `poll:{userId}` — a slow poll must not overlap the next tick. Contention is normal; the job
   exits cleanly.
2. `task:{userId}:{key}` — two jobs must never sync the same task at once. Contention is an
   error; the job **fails** and BullMQ retries with backoff.
3. `todoist-token:{userId}` — refresh-token rotation must be serialized (see below).

Locks carry a TTL and an owner. Only the owner can release one, and an expired lock can be stolen,
so a crashed worker cannot deadlock the system.

## Credentials

Todoist tokens and the Glassfrog API key are stored in plaintext in the database.

Todoist access tokens expire after an hour and **the refresh token rotates on every refresh**,
with the previous one dying after ~60 seconds. `getValidAccessToken()` therefore takes the token
lock, re-reads inside it (another process may have just refreshed), refreshes, and persists the
new refresh token. Bypassing it risks permanently breaking the connection.

## Avoiding sync ping-pong

Writing to either API bumps that record's `updated_at`, so the next poll sees our own write as a
change. Two defenses, both required:

1. After every write, re-read the resulting timestamp and store it in `task_mapping`.
2. Store a `contentHash` of the normalized field set. A delta whose hash matches the stored one is
   our own echo and is dropped.

Without both, the two systems would overwrite each other forever.
