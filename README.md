# Todoist ⇄ Glassfrog Sync

Two-way sync between [Glassfrog](https://glassfrog.com) Actions and [Todoist](https://todoist.com)
Tasks, with the Glassfrog role/project hierarchy mirrored into a Todoist project tree.

Built for personal use: one account, self-hosted, polling-based.

## What it does

- **Hierarchy (one-way, Glassfrog → Todoist).** Every Glassfrog role you fill becomes a Todoist
  project under a root project you choose. Glassfrog projects and sub-projects nest beneath their
  role. Todoist projects under the root with no Glassfrog counterpart are archived.
- **Tasks (two-way).** Each Glassfrog Action maps to a Todoist Task. Edits, completions, and
  deletions propagate in both directions; the more recently modified side wins.
- **Polling.** A scheduled job runs every 60 seconds (configurable), reconciles the hierarchy,
  then queues one job per changed task.

## Requirements

- Node.js ≥ 22.22 (developed on 24)
- Docker (for Postgres + Redis)
- A Todoist OAuth app
- A Glassfrog API v5 key

## Setup

### 1. Datastores

```bash
docker compose up -d
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
signing in — it is encrypted before being stored.

### 4. Environment

```bash
cp .env.example .env
openssl rand -base64 32    # → BETTER_AUTH_SECRET
openssl rand -base64 32    # → ENCRYPTION_KEY
```

Fill in the Todoist client ID and secret. `ENCRYPTION_KEY` must be exactly 32 bytes, base64
encoded — **changing it later makes every stored credential unreadable.**

### 5. Install and run

```bash
npm install
npm run db:migrate
npm run dev
```

The app is at <http://localhost:5173>. `npm run dev` starts both the web server and the
background worker; the worker must be running for any syncing to happen.

Sign up, then use the dashboard to connect Todoist, save your Glassfrog key, and pick a root
Todoist project. Set `ALLOW_SIGNUP=false` afterwards to close the instance.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SYNC_INTERVAL_MS` | `60000` | How often the poll job runs |
| `PRUNE_MODE` | `archive` | `dry-run` logs unmapped Todoist projects; `archive` archives them |
| `ALLOW_SIGNUP` | `true` | Set `false` to close signups after creating your account |
| `LOG_LEVEL` | `info` | pino log level |

**Tip:** run with `PRUNE_MODE=dry-run` for the first sync, check the dashboard activity log to
confirm the hierarchy looks right, then switch to `archive`.

## Development

```bash
npm run dev          # web + worker
npm run dev:web      # web only
npm run dev:worker   # worker only
npm run check        # biome + typecheck
npm run test         # vitest (requires Postgres running)
npm run db:generate  # generate a migration after editing server/db/schema/
npm run db:studio    # browse the database
```

### Regenerating the Glassfrog client

The Glassfrog v5 API is in beta, so its OpenAPI spec is vendored at `openapi/glassfrog.json` and
the client is generated from that file. To pick up upstream changes:

```bash
npm run gen:glassfrog:fetch   # re-download the spec + regenerate, then review the diff
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
