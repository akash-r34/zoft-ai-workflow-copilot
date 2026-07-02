# Phase 0: Foundation and Skills

Goal: a runnable monorepo skeleton with the frontend/backend boundary encoded in
a shared contract package, plus the Docker base for local infrastructure. No
product logic yet.

## Step 0.1: Skill discovery (do this first)

The brief requires starting with skill discovery. Run, at the repo root:

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills
```

Then use the installed `find-skills` capability to search for skills relevant to
this build. Search for terms that match the work ahead:

- `next.js`, `react`, `server components`, `streaming`
- `fastify` or `node api`, `sse`, `server-sent events`
- `prisma`, `postgres`, `pgvector`, `embeddings`
- `bullmq`, `redis`, `background jobs`, `queue`
- `llm`, `agent`, `tool calling`, `structured output`
- `docker`, `docker compose`

Record every skill the tool recommends in `docs/skills-report.md` with a one-line
note on where in the plan it applies. Add the genuinely relevant ones. This report
is a deliverable-adjacent artifact that shows deliberate tooling choices.

Acceptance: `find-skills` installed, `docs/skills-report.md` written, chosen
skills added to the repo.

## Step 0.2: Monorepo scaffold

Layout:

```
zoft-copilot/
  apps/
    backend/        Fastify service
    frontend/       Next.js app
  packages/
    contract/       Shared API types + zod schemas (the boundary)
  infra/
    docker-compose.yml
  docs/
  turbo.json
  pnpm-workspace.yaml
  package.json
```

- Initialise pnpm workspaces and Turborepo.
- `packages/contract` exports: DTOs, zod schemas for request/response bodies, the
  SSE event union type, and the error model. Both apps depend on it. Neither app
  redefines a shared type locally.
- Strict TypeScript everywhere (`strict: true`, `noUncheckedIndexedAccess: true`).
- Shared ESLint + Prettier config. Prettier set to no special dash handling; keep
  prose in docs using plain hyphens only.

Acceptance: `pnpm install` succeeds, `pnpm -r build` builds all three packages,
`pnpm -r typecheck` passes on empty stubs.

## Step 0.3: Local infrastructure

`infra/docker-compose.yml` brings up:

- `postgres` (with a startup script that runs `CREATE EXTENSION IF NOT EXISTS vector;`)
- `redis`

Backend reads `DATABASE_URL` and `REDIS_URL` from env. Provide `.env.example`
for both apps. No real credentials committed.

Acceptance: `docker compose -f infra/docker-compose.yml up` starts Postgres with
the vector extension available and Redis reachable.

## Step 0.4: Tooling and CI baseline

- Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`.
- A minimal CI workflow that runs lint, typecheck, and tests.
- Vitest configured in backend for unit tests (the deterministic core gets the
  most coverage).
- Commit hooks (lint-staged) optional but recommended.

Acceptance: CI config present and green on the scaffold; `pnpm test` runs (even
with a single placeholder test).

## Definition of done for Phase 0

- Skills discovered, added, and reported.
- Monorepo builds and typechecks with the shared contract in place.
- `docker compose up` provides Postgres (vector-enabled) and Redis.
- Lint, typecheck, and test scripts wired and passing.
