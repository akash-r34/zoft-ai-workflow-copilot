# 14 — Operations, Docker, and Configuration Reference

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

## The full environment variable reference

Every variable below is validated by `apps/backend/src/config/env.ts`'s `EnvSchema`
(`08-api-and-runs.md`) — an invalid or missing required value fails the process at boot,
not three layers deep at runtime.

| Variable | Default | Read by | What it controls |
|---|---|---|---|
| `PORT` | `3001` | `index.ts` | API server listen port |
| `HOST` | `0.0.0.0` | `index.ts` | API server bind address |
| `LOG_LEVEL` | `info` | `app.ts` (Fastify logger) | Log verbosity |
| `DATABASE_URL` | *(required)* | Prisma | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | `redis/connection.ts` | Redis connection string — hard dependency (SSE pub/sub + BullMQ) |
| `LLM_PROVIDER` | `mock` | `providers/factory.ts` | `"mock"` or `"anthropic"` (the latter throws — not implemented, see `REMAINING.md`) |
| `ANTHROPIC_API_KEY` | *(unset)* | *(unused today)* | Reserved for the future `AnthropicProvider` |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | *(unused today)* | Reserved for the future `AnthropicProvider` |
| `SELF_CORRECTION_BUDGET` | `1` | `agent/orchestrator.ts` | Repair attempts after a failed proposal (PRD v1.1 Decision #2) |
| `RUN_DEADLINE_MS` | `6000` | `agent/orchestrator.ts` | Wall-clock budget per run before forced `run.timeout` |
| `APPROVAL_REQUIRED` | `true` | `agent/orchestrator.ts` | PRD v1.1 Decision #1 — `false` is a legacy/test auto-commit escape hatch |
| `CORS_ORIGIN` | `http://localhost:3000` | `app.ts`, `runs/sse.ts` | Allowed browser origin (incl. the hijacked SSE route's manual CORS header) |
| `PROVIDER_FAILURE_THRESHOLD` | `3` | `providers/router.ts` | Consecutive failures before a provider's circuit breaker trips open |
| `PROVIDER_BREAKER_COOLDOWN_MS` | `30000` | `providers/router.ts` | How long a breaker stays open before a half-open trial |
| `ARCHIVE_AFTER_DAYS` | `90` | `workers/archival-worker.ts` | PRD v1.1 Decision #3 — versions older than this get `archivedAt` set |
| `ARCHIVE_CRON` | `0 3 * * *` | `workers/main.ts` | BullMQ repeatable-job schedule for the archival sweep |
| `WORKER_CONCURRENCY` | `2` | all three `workers/*.ts` | BullMQ `Worker` concurrency, shared across the three queues |

Frontend (`apps/frontend/.env.example`):

| Variable | Default | Read by | What it controls |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` (fallback baked into `lib/api.ts:18` if unset) | `lib/api.ts` | Base URL for every REST call + the SSE stream URL |

Never commit a `.env` file — only `.env.example` files are tracked (`CLAUDE.md`).

## Three ways to run this locally

### 1 — Full stack in Docker, zero setup

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

Boots Postgres (pgvector), Redis, the real backend, the worker process, and the production
frontend build — from a clean checkout, no API keys, no `.env` file needed at all (every
default in the table above is chosen so this works out of the box: `LLM_PROVIDER=mock`,
`APPROVAL_REQUIRED=true`). Frontend on `http://localhost:3000`, backend on
`http://localhost:3001`. Tear down with `docker compose -f infra/docker-compose.yml down`
(add `-v` to also drop the Postgres data volume).

### 2 — Real backend + worker locally, frontend against it

```bash
docker compose -f infra/docker-compose.yml up -d          # Postgres + Redis only
pnpm --filter @zoft/backend dev                            # API on :3001
pnpm --filter @zoft/backend worker                          # separate terminal — the BullMQ workers
pnpm --filter @zoft/frontend exec next dev -p 3000           # separate terminal — Next.js only, NOT the "dev" script
```

**Read the last line carefully — it's not `pnpm --filter @zoft/frontend dev`.** That
package's own `"dev"` script is `concurrently -n ui,mock -c blue,magenta "next dev -p 3000"
"tsx watch mock/server.ts"` (`apps/frontend/package.json:7`) — it starts **both** Next.js
*and* the mock backend (`11-mock-backend.md`) together, and the mock defaults to port
`3001` (`mock/server.ts:373`, `Number(process.env.MOCK_PORT ?? 3001)`) — **the same default
port the real backend uses.** Run the frontend's own `dev` script while the real backend is
also up on `3001` and you'll get a port collision (whichever process binds `3001` first
wins; the other fails to start). This is why the root-level `pnpm dev` (which runs every
package's `dev` script in parallel via Turborepo, `turbo.json:8-11`) is **not** the
right command when you want the frontend talking to the *real* backend — it will also try
to boot the mock on the same port. Invoke `next dev` directly instead, as shown above, when
you specifically want the frontend against the real backend.

### 3 — Frontend + mock only, no backend/database/Redis at all

```bash
pnpm --filter @zoft/frontend dev
```

This *is* the right command for this use case — it starts Next.js on `:3000` and the mock
on `:3001` together, with no Postgres, no Redis, and no real backend process needed at all.
See `11-mock-backend.md` for what you get and don't get with this path.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Backend throws "Invalid environment configuration" at boot | A required env var (`DATABASE_URL`) is missing, or an enum-typed one (`LLM_PROVIDER`, `APPROVAL_REQUIRED`) has a value outside its allowed set | Check the fields the error logs; compare against `.env.example` |
| `LLM_PROVIDER=anthropic` throws immediately | Deliberate — no `AnthropicProvider` implementation exists yet | Use `LLM_PROVIDER=mock` (the default); see `REMAINING.md` |
| Frontend can't reach the backend / CORS error in the browser console | `CORS_ORIGIN` (backend) doesn't match the origin the frontend is actually served from, or `NEXT_PUBLIC_API_URL` (frontend) points at the wrong port | Confirm both match your actual setup; the SSE route manually sets `Access-Control-Allow-Origin` from `CORS_ORIGIN` (`08-api-and-runs.md`) |
| `EADDRINUSE` on port 3001 when starting the frontend | The frontend's own `dev` script also starts the mock on 3001 (see above) | Use `next dev -p 3000` directly instead of the frontend's `dev` script, when the real backend is also running |
| A DB-gated test "hangs" or errors when just running `pnpm test` | Never happens by design — those tests check `RUN_DB_INTEGRATION_TESTS`, not `DATABASE_URL` presence | See `13-testing.md`'s explanation; if you see this, something added a test that gates incorrectly |
| `npx prisma migrate dev --name ...` fails with `P3006 ... type "vector" does not exist` | Prisma's shadow database (used to validate a migration) doesn't have the `vector` extension enabled | Hand-write the migration SQL and apply with `prisma migrate deploy` instead — see `04-data-model.md`'s migrations section |
| `pnpm install` fails to build `msgpackr-extract` | An optional native addon of `ioredis`; skipped on purpose | Already handled — `pnpm-workspace.yaml`'s `allowBuilds.msgpackr-extract: false` disables it; the pure-JS fallback is used |
| Docker build fails with `Cannot read file '/app/tsconfig.base.json'` | `turbo prune --docker` only understands the package.json dependency graph, not relative `tsconfig`/`eslintrc` `extends` paths | Already handled in both Dockerfiles via an explicit `COPY --from=pruner /app/tsconfig.base.json` — if you add a new package, make sure its Dockerfile (if any) does the same |
| Docker build fails on Node version / a `node:sqlite` error | `node:20-slim` is too old for the pinned `pnpm@11.9.0` (needs Node ≥22.13) | Already handled — both Dockerfiles use `node:22-slim` |

## Adding a new Prisma migration

For a normal (non-`vector`-touching) schema change:

```bash
# edit apps/backend/prisma/schema.prisma first, then:
pnpm --filter @zoft/backend exec prisma migrate dev --name descriptive_name
```

For a change touching a `vector(...)` column (or anything else the shadow database can't
validate), write the migration SQL by hand under
`apps/backend/prisma/migrations/<timestamp>_<name>/migration.sql` (match the existing
`20260704121807_add_node_embedding` and `20260704122900_add_version_archived_at` migrations
as templates — both are 1–2 line `ALTER TABLE` statements), then apply it without shadow-DB
validation:

```bash
pnpm --filter @zoft/backend exec prisma migrate deploy
```

Either way, update `schema.prisma` itself to match (Prisma won't do this for you when you
hand-write SQL) — `04-data-model.md` documents each model's current shape as the reference.

## The Docker build, in detail

Both `apps/backend/Dockerfile` and `apps/frontend/Dockerfile` use the same four-stage
pattern, following [Turborepo's own documented Docker
guide](https://turbo.build/repo/docs/guides/tools/docker) rather than a bespoke one:

```
base      node:22-slim + corepack enable (+ openssl for the backend, Prisma needs it)
  │
pruner    `npx turbo prune @zoft/<app> --docker` — extracts just this app + its
  │       internal deps (@zoft/contract) into a minimal, correctly-lockfiled subset
  │
installer COPY the pruned package.json files only, `pnpm install --frozen-lockfile`
  │       (this layer is cacheable — only invalidated by dependency changes, not source edits)
  │
builder   COPY the full pruned source, build @zoft/contract, then the target app
  │       (+ `prisma generate` for the backend)
  ▼
runner    Slim runtime image — just the built output, not the whole toolchain
```

**Build from the monorepo root, not the app directory** — both Dockerfiles' own header
comments state this explicitly, since a pnpm/Turborepo workspace's build context has to be
the repo root:

```bash
docker build -f apps/backend/Dockerfile -t zoft-backend .
docker build -f apps/frontend/Dockerfile -t zoft-frontend .
```

(`infra/docker-compose.yml`'s `backend`/`frontend`/`worker` services do exactly this via
`context: ..` + an explicit `dockerfile:` path — `docker-compose.yml:37-40,59-62,74-77`.)

### `docker-entrypoint.sh` — how the backend image boots

```sh
# apps/backend/docker-entrypoint.sh (full file)
#!/bin/sh
set -e
npx prisma migrate deploy
npx prisma db seed
exec "$@"
```

Both the `backend` and `worker` Compose services use this **same image and entrypoint**
(`docker-compose.yml:37-72`) — the `worker` service just overrides the final command
(`command: ["node", "dist/workers/main.js"]`, `docker-compose.yml:64`). Both
`prisma migrate deploy` (only applies pending migrations — a no-op if already applied) and
`prisma db seed` (an idempotent upsert keyed on node `type`, `prisma/seed.ts:117-121`) are
safe to run redundantly on every container start, including when both services start
simultaneously (`docker-entrypoint.sh:5-8`'s comment: Prisma takes its own advisory lock for
concurrent-deploy safety).

### Why the frontend image needs no runtime env var for the API URL

`apps/frontend/Dockerfile`'s header comment explains a subtlety worth knowing if you ever
touch it: `NEXT_PUBLIC_API_URL` is a **build-time** value — Next.js inlines
`NEXT_PUBLIC_*` vars into the client bundle at `next build`, not read at container runtime —
so it's deliberately left unset in the Dockerfile, letting `lib/api.ts:18`'s own fallback
(`http://localhost:3001`) get baked in. That's correct for this deployment shape: the
*browser* runs on the host machine, not inside the Docker network, so it needs to reach the
backend via its published host port (`localhost:3001`), never the internal Docker service
hostname (`backend`) — which is what `docker-compose.yml`'s `backend`/`worker` services use
for their own `DATABASE_URL`/`REDIS_URL` (`docker-compose.yml:48-49`, service-name hostnames
via Docker's internal DNS).

## `docker-compose.yml` service map

```
postgres   pgvector/pgvector:pg16, port 5432, healthcheck: pg_isready
redis      redis:7-alpine, port 6379, healthcheck: redis-cli ping
backend    apps/backend/Dockerfile, port 3001, depends_on both healthy
worker     SAME image as backend, command: node dist/workers/main.js, depends_on both healthy
frontend   apps/frontend/Dockerfile, port 3000, depends_on: backend
```

`depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_healthy } }`
(not just "started") matters because Redis became a **hard** runtime dependency
(`08-api-and-runs.md`) — the backend and worker would otherwise potentially start before
Redis is actually accepting connections.

---
**Prev:** [`13-testing.md`](./13-testing.md) · **Next:**
[`15-extending.md`](./15-extending.md) · **Related:**
[`01-getting-started.md`](./01-getting-started.md),
[`../architecture.md`](../architecture.md)
