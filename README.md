# Todoist ⇄ Glassfrog Sync

Two-way sync between [Glassfrog](https://glassfrog.com) Actions and [Todoist](https://todoist.com)
Tasks, with the Glassfrog role/project hierarchy mirrored into a Todoist project tree.

Built for personal use: one account, self-hosted, polling-based.

## What it does

- **Hierarchy (one-way, Glassfrog → Todoist).** Every Glassfrog role you fill becomes a Todoist
  project under a root project you choose. Glassfrog projects and sub-projects nest beneath their
  role. Todoist projects under the root with no Glassfrog counterpart are archived.
- **Tasks (two-way).** Each Glassfrog Action maps to a Todoist Task. Edits and completions
  propagate in both directions; the more recently modified side wins.
- **Deletion (one-way).** Deleting or cancelling an Action deletes its Todoist task. Deleting the
  task in Todoist does _not_ delete the Action — the task is re-created from it on the next sync.
  Glassfrog is the system of record.
- **Polling.** A scheduled job runs every hour by default (configurable via `SYNC_INTERVAL_MS`),
  reconciles the hierarchy, then queues one job per changed task.

## Requirements

- Node.js ≥ 22.22 (developed on 24)
- Docker (for Postgres + Redis)
- A Todoist OAuth app
- A Glassfrog API v5 key

## Setup

### 1. Datastores

For local development you run the web server and worker directly with `yarn dev`, so start
only Postgres and Redis in Docker:

```bash
docker compose up -d postgres redis
```

### 2. Todoist OAuth app

Create an app at <https://app.todoist.com/app_console/>. Set the redirect URI to:

```
http://localhost:5173/oauth/todoist/callback
```

Note the client ID and client secret. The app requests the `data:read_write`, `data:delete`, and
`project:delete` scopes — needed to write tasks, delete tasks, and archive projects.

> New Todoist OAuth apps issue **access tokens that expire after one hour** along with a rotating
> refresh token. This app refreshes automatically; you should not need to reconnect.

### 3. Glassfrog API key

Generate an **API v5** key from your Glassfrog profile. You paste it into the dashboard after
signing in.

### 4. Environment

```bash
cp .env.example .env
openssl rand -base64 32    # → BETTER_AUTH_SECRET
```

Fill in the Todoist client ID and secret.

### 5. Install and run

Package management is Yarn 4, pinned by the `packageManager` field and provisioned by
Corepack — run `corepack enable` once and the right Yarn is used automatically.

```bash
corepack enable
yarn install
yarn db:migrate
yarn dev
```

The app is at <http://localhost:5173>. `yarn dev` starts both the web server and the
background worker; the worker must be running for any syncing to happen.

Sign up, then use the dashboard to connect Todoist, save your Glassfrog key, and pick a root
Todoist project. Set `ALLOW_SIGNUP=false` afterwards to close the instance.

## Configuration

| Variable           | Default   | Purpose                                                  |
| ------------------ | --------- | -------------------------------------------------------- |
| `SYNC_INTERVAL_MS` | `3600000` | How often the poll job runs                              |
| `ALLOW_SIGNUP`     | `true`    | Set `false` to close signups after creating your account |
| `LOG_LEVEL`        | `info`    | pino log level                                           |

## Development

```bash
yarn dev          # web + worker
yarn dev:web      # web only
yarn dev:worker   # worker only
yarn check        # prettier --check + eslint + typecheck
yarn format       # prettier --write
yarn lint:fix     # eslint --fix
yarn test         # vitest (requires Postgres running)
yarn db:generate  # generate a migration after editing server/db/schema/
yarn db:studio    # browse the database
```

### Regenerating the Glassfrog client

The Glassfrog v5 API is in beta, so its OpenAPI spec is vendored at `openapi/glassfrog.json` and
the client is generated from that file. To pick up upstream changes:

```bash
yarn gen:glassfrog:fetch   # re-download the spec + regenerate, then review the diff
```

## Running it in Docker

Plain `docker compose up -d` runs the full production stack: Postgres, Redis, and three
services built from one image — `migrate`, `web`, and `worker`. (For local development,
where you run `web`/`worker` directly with `yarn dev`, start only the datastores — see
[Setup](#1-datastores).)

`migrate` applies drizzle migrations, then seeds the single user account if
`INITIAL_USER_EMAIL`/`INITIAL_USER_PASSWORD` are set (see `.env.example`), then serves a
health check indefinitely — `web` and `worker` both wait on it being healthy before they
start, so migrations only ever run once per deploy. `web` serves on port 3000; `GET
/healthz` reports the status of both datastores.

```bash
docker compose up -d --build
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Contributors using Claude Code should also read
[CLAUDE.md](CLAUDE.md) — several dependencies are a major version ahead of common knowledge.

## Backups

The Postgres volume holds the only copy of the Todoist ↔ Glassfrog ID mappings. If you lose it,
the next sync cannot tell existing tasks from new ones. Back it up before anything destructive:

```bash
docker compose exec postgres pg_dump -U todoist_sync todoist_sync > backup.sql
```
