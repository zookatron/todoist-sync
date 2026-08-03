# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A personal-use web app that two-way syncs Glassfrog **Actions** with Todoist **Tasks**, and
mirrors the Glassfrog role/project hierarchy into a Todoist project tree. Single user per
account, self-hosted, polling-based.

## ⚠️ Version traps — read this before writing any code

Several libraries here are on a **major version newer than most training data**. Defaulting to
remembered APIs will produce code that does not compile. When unsure, read the installed source
of truth listed in each row.

| Library              | Installed | The trap                                                                                                                                                                                                                                                                                                                                                                                                                                           | Source of truth                                                                      |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| React Router         | **8**     | Not v7. ESM-only. `react-router-dom` **does not exist** — import from `react-router` / `react-router/dom`. Middleware is **baseline** (no future flag). Needs Node ≥22.22, React ≥19.2.7, Vite ≥7.                                                                                                                                                                                                                                                 | `node_modules/react-router/docs/` (version-matched) + `.agents/skills/react-router/` |
| HeroUI               | **3**     | Not v2/NextUI. **No `HeroUIProvider`.** No `tailwind.config.js` plugin — setup is two CSS `@import`s. Compound-component API, built on React Aria. `Image` was removed. **There is no `color` prop** — `Button` takes `variant` (`primary`, `secondary`, `tertiary`, `danger`, `danger-soft`, `ghost`, `outline`) and `size` (`sm`/`md`/`lg`). Check `node_modules/@heroui/react/dist/components/<name>/` for the real prop types before guessing. | `node_modules/@heroui/react/dist/components/`                                        |
| BullMQ               | **6**     | Use **Job Schedulers** (`queue.upsertJobScheduler`), not the deprecated repeatable-jobs API (`repeat` on `add`). v6 introduced pluggable backends; Redis is still the default.                                                                                                                                                                                                                                                                     | `node_modules/bullmq/dist/esm/` typings                                              |
| `@doist/todoist-sdk` | **13**    | Not `@doist/todoist-api-typescript` v1. Fields are **camelCase** (`updatedAt`, `isDeleted`, `projectId`). Incremental deltas come from `api.sync({ syncToken, resourceTypes })`. OAuth helpers are **free functions**, not methods.                                                                                                                                                                                                                | `node_modules/@doist/todoist-sdk/dist/types/`                                        |
| Better Auth          | **1.6**   | `@better-auth/drizzle-adapter` is a **separate package** from `better-auth`. The `@better-auth/cli` publishes at 1.4.x and lags — do not let it dictate schema; verify generated tables against the docs.                                                                                                                                                                                                                                          | https://www.better-auth.com/docs                                                     |
| Tailwind             | **4**     | CSS-first config. No `tailwind.config.js`. `@theme` / `@custom-variant` in CSS.                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                    |
| Drizzle              | **0.45**  | Not the 1.0 beta line.                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                    |
| TypeScript           | **5.9**   | Deliberately not 7.x — the native port is unproven against tRPC v11 / Drizzle deep generics.                                                                                                                                                                                                                                                                                                                                                       | —                                                                                    |
| Yarn                 | **4.18**  | Not Classic 1.x — the `yarn` npm package is a legacy shim. Provisioned by **Corepack** from `packageManager`; there is no checked-in release binary. **`nodeLinker: node-modules`**, not PnP. Dependency **build scripts are disabled by default** in v4 — a package needing one must be listed in `dependenciesMeta.<pkg>.built`. `npm ci` → `yarn install --immutable`; `npm ci --omit=dev` → `yarn workspaces focus --all --production`.        | `.yarnrc.yml` + https://yarnpkg.com/configuration/yarnrc                             |

## Architecture

```
app/      React Router v8 routes and UI only (framework mode, SSR)
server/   All business logic. Imported by BOTH the web app and the worker.
worker/   BullMQ worker process entrypoint (separate process from the web server)
```

`server/` lives **outside `app/`** so `worker/` can import it without pulling in React Router's
route-module graph. Both reach it via the `@server/*` path alias.

Read `docs/ARCHITECTURE.md` for the sync data flow.

## Conventions

- **Never hand-write Glassfrog HTTP calls.** The client in `server/glassfrog/generated/` is
  generated from the vendored `openapi/glassfrog.json`. To change it, run
  `yarn gen:glassfrog:fetch` and review the diff. Generated files are committed, and are
  excluded from ESLint and from `prettier --write` (the generator formats them itself).
  `server/todoist/generated/` is the same arrangement (`yarn gen:todoist:fetch`) but is
  **types only** — the app talks to Todoist through the SDK, and these types exist to
  describe the _wire_ format for the test simulator.
- **Never log credentials.** Todoist tokens and the Glassfrog API key are stored in plaintext in
  the database. The pino logger has a redaction list; keep it current.
- **Always get Todoist tokens via `getValidAccessToken(userId)`** (`server/todoist/oauth.ts`).
  Never read the token column directly — access tokens expire hourly and refresh tokens
  **rotate**, so a bypassed refresh path will brick the connection.
- **Sync decision logic must stay pure.** `server/sync/resolve.ts` and the hierarchy diff take
  plain data and return operations, with no I/O. That is what makes them unit-testable; keep API
  calls in the callers. (The stateful callers around them are covered end to end instead — see
  Testing below. Neither approach replaces the other.)
- Environment access goes through `server/utils/env.ts` (zod-validated at import), never
  `process.env` directly.

## The two bugs most likely to bite

1. **Sync ping-pong.** Writing to either side bumps that side's `updated_at`, and the next poll
   will hand our own write back to us as a change. Two defenses, both required: store the
   post-write timestamp in `task_mapping`, and compare a `contentHash` of the normalized fields
   to detect echoes.
2. **Refresh-token rotation loss.** Todoist rotates the refresh token on every refresh and the
   old one dies after ~60s. Refreshes are serialized with the DB lock and must persist the new
   refresh token in the same transaction.

## Commands

```bash
corepack enable                        # once per machine — provisions the pinned Yarn
docker compose up -d postgres redis    # datastores only, for local dev (`yarn dev`)
docker compose up -d --build           # full production stack: migrate + web + worker too
yarn install                           # `yarn install --immutable` in CI
yarn db:migrate                        # apply migrations
yarn dev                               # web (5173) + worker together
yarn check                             # prettier --check + eslint + tsc  ← run before finishing work
yarn format                            # prettier --write
yarn lint:fix                          # eslint --fix
yarn test                              # vitest — needs no postgres, redis or network
yarn db:generate                       # after editing server/db/schema/
yarn gen:glassfrog:fetch               # re-vendor + regenerate the Glassfrog client
yarn gen:todoist:fetch                 # re-vendor + regenerate the Todoist wire types
```

## Testing

**Read `docs/TESTING.md` before writing tests.** The short version:

- The suite needs **no Postgres, no Redis and no network**. `yarn test` passes with
  `docker compose down`; anything reaching a real service is a setup bug.
- Stateful in-memory simulators stand in at the process boundary — `DatabaseSimulator`
  (PGlite running the real migrations), `GlassfrogSimulator` and `TodoistSimulator` (msw),
  `QueueSimulator`. Code under test runs **unmodified**: prefer this over `vi.mock`, which
  would replace the layer where the bugs actually live.
- Pure logic (`resolve.ts`, `hierarchy-diff.ts`, the `delta.ts` files) still gets plain unit
  tests.
- Four production seams exist only for this — `setDatabase`, `setTodoistTransport`,
  `setTaskQueue`, `setPollQueue`. They are inert until a simulator sets them. Never call
  them from application code.
- The Todoist SDK **bypasses msw** on Node (npm-undici's own `fetch`, not `globalThis.fetch`).
  `server/todoist/transport.ts` is the required workaround; a new Todoist call path that
  skips it will hit the real API.

## Linting

ESLint 9-style flat config in `eslint.config.js`, with **type-aware** rules
(`recommendedTypeChecked` + `projectService`). That is deliberate: this codebase is almost
entirely async database and HTTP calls, so `no-floating-promises` and `no-misused-promises`
catch real bugs `tsc` does not. Formatting is Prettier's job alone —
`eslint-config-prettier` is last in the config and switches off every rule that would fight it.

Two deviations worth knowing before you "fix" them:

- `eslint-plugin-react` is **not** installed — no release supports ESLint 10.
  `eslint-plugin-react-hooks` is, and covers the rules that matter.
- `only-throw-error` is configured to allow throwing a `Response`, because
  `throw redirect(...)` is the React Router idiom for short-circuiting a loader.

Also note: **the worker is bundled for production** (`yarn build:worker` →
`build/worker/index.js`) so `tsx` stays a dev dependency. `yarn dev:worker` still runs the
TypeScript directly.

## API constraints worth remembering

- **Glassfrog v5 is beta.** It has **no org-wide action list** and **no `updated_since` filter**.
  Change detection is enumerate-and-diff over `/me/actions` (cursor-paginated). Auth is a static
  API key in `X-Auth-Token`.
- **Todoist** gives real incremental deltas via `/sync` with a `sync_token`, including deletions
  (`isDeleted`). Use it; do not poll full task lists.
