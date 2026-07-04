# Zoft AI Workflow Copilot

A natural-language AI assistant for building Zapier/n8n-style automation workflows.
Users type "send a Slack message whenever Stripe receives a payment" and the Copilot
creates, edits, explains, validates, and repairs workflows through a streaming chat UI.

---

## The one rule that governs every design decision

**The AI proposes operations. Deterministic code validates and applies them.
The AI never writes to the database directly.**

1. The agent reasons and calls tools (search nodes, read schema, propose operations).
2. It emits a typed **operation patch** — never raw SQL or a full graph replacement.
3. A deterministic validator (no LLM) checks catalog membership, JSON Schema config
   validity, DAG structure, trigger rules, and type compatibility.
4. Only on a clean validation pass does the version applier write one new immutable
   `workflow_version` row and update `workflow.currentVersionId`.

This single invariant gives us: safety, operation-based editing, full version history,
audit trail, and a well-defined recovery surface for every LLM failure mode.

---

## Monorepo layout

```
zoft-copilot/
  apps/
    backend/      Fastify API + AI orchestration (Node.js + TypeScript, ESM)
    frontend/     Chat UI + workflow viz (Next.js 14 App Router)
  packages/
    contract/     Shared types, Zod schemas, SSE event union — the API boundary
  infra/
    docker-compose.yml   Postgres (pgvector/pgvector:pg16) + Redis
    init-db.sql          CREATE EXTENSION IF NOT EXISTS vector
  docs/
  .github/workflows/ci.yml
```

**Never define a shared type outside `packages/contract`.** Both apps import from
`@zoft/contract`; neither redefines what already lives there. A change to the boundary
is a deliberate, reviewable edit to `packages/contract` first. Detail:
`.claude/memory/contract-package.md`.

---

## Development commands

```bash
pnpm install                        # install all workspace deps
pnpm --filter @zoft/contract build  # build the contract first (both apps depend on it)
pnpm -r build                       # build all packages
pnpm -r typecheck                   # typecheck all packages
pnpm -r lint                        # lint all packages (zero errors required)
pnpm test                           # run all tests via Turbo

# Local infra (requires Docker Desktop)
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml down
```

For development: `pnpm dev` runs all packages in parallel via Turbo. Backend on
port 3001, frontend on port 3000.

---

## TypeScript conventions

All packages extend `tsconfig.base.json` at the repo root:

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,    // array[i] is T | undefined
  "noImplicitOverride": true,
  "exactOptionalPropertyTypes": true,  // undefined ≠ absent
  "module": "NodeNext",
  "moduleResolution": "NodeNext"       // requires .js extensions in imports
}
```

- **Import extensions**: use `.js` for all local imports in ESM packages
  (`import { foo } from "./bar.js"`).
- **`_` prefix** on intentionally-unused variables/types is recognised
  (`varsIgnorePattern: "^_"` in ESLint).
- **No `any`** — `@typescript-eslint/no-explicit-any` is an error.
- **No `console.log`** in source — `no-console` warns; `console.warn` and
  `console.error` are allowed.
- Package-local `tsconfig.json`/`.eslintrc.json` overrides are normal (e.g.
  `esModuleInterop` where a CJS dependency needs it) — extend the root config, don't
  fork it.

## ESLint and Prettier

Root base config: `.eslintrc.base.json`. Each package has its own `.eslintrc.json`
extending the root. Frontend extends `next/core-web-vitals` (pinned to
`eslint-config-next@14.2.0` to match Next.js 14 and ESLint 8).

Prettier: double quotes, semi, trailing commas, 100-char print width.
Format check is part of CI. Run `pnpm exec prettier --write .` to format.

---

## Environment variables

Backend (`.env.example`):
```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/zoft?schema=public"
REDIS_URL="redis://localhost:6379"
PORT=3001
LOG_LEVEL=info
LLM_PROVIDER=mock          # set to "anthropic" to use the real API
ANTHROPIC_API_KEY=         # only needed when LLM_PROVIDER=anthropic
```

Frontend (`.env.example`):
```
NEXT_PUBLIC_API_URL=http://localhost:3001
```

Never commit a `.env` file. Only `.env.example` files are tracked. Note:
`@prisma/client` auto-loads `apps/backend/.env` as an import side effect — don't gate
DB-dependent tests on `DATABASE_URL` alone; use a dedicated opt-in flag (see
`apps/backend/src/core/__tests__/version-applier.integration.test.ts` for the pattern).

---

## CI (`.github/workflows/ci.yml`)

On push to `main`/`develop` and PRs to `main`: install (frozen lockfile) → build
contract → typecheck all → lint all → test all. All five steps must be green before
merging.

---

## Build phases

| Phase | What it adds | Status |
|-------|-------------|--------|
| 0 | Monorepo scaffold, contract package, Docker infra | ✅ Done |
| 1 | Prisma schema, node catalog seed, deterministic core + tests | ✅ Done |
| 2 | LLM provider abstraction, agent loop, RAG, self-correction | ✅ Done (core) — advanced pieces in `REMAINING.md` |
| 3 | SSE streaming, BullMQ workers, cancellation, circuit breaker | ✅ Done (core) — advanced pieces in `REMAINING.md` |
| 4 | Frontend chat core, SSE client, activity timeline | ✅ Done (built early, against a mock backend — see below) |
| 5 | React Flow viz, diff highlight, version history, failure states | ✅ Done (built early, against a mock backend — see below) |
| 6 | Production Dockerfiles, architecture docs, API docs, demo video | — (see `REMAINING.md`) |

**Note on ordering:** Phases 4–5 (the frontend) were built out of sequence, ahead of
the backend's Phase 2–3, against a self-contained mock backend
(`apps/frontend/mock/`) that implements the real `packages/contract` REST + SSE
surface. Phase 2–3 (core) has since landed: a real Postgres-backed Fastify backend
with real REST + SSE, a real agent loop driven by the deterministic `MockProvider`,
and (per PRD v1.1 Decision #1) a mandatory human approval gate between validation
and commit. The frontend runs against it with no changes beyond the new
`ApprovalPanel` UI the approval gate itself required. `apps/frontend/mock/` is kept
as a faithful, independent peer implementation (both now emit `workflow.proposed`
and expose `/approve`/`/reject`), not replaced. Detail: `.claude/memory/build-phases.md`.
Deferred advanced pieces (real `AnthropicProvider`, provider circuit breaker,
pgvector RAG, BullMQ workers, all of Phase 6): `REMAINING.md` at repo root.

Per-phase detail (what each adds, decisions made, deviations from spec):
`.claude/memory/build-phases.md`.

---

## Where to look for more

The sections above are the load-bearing rules and the commands you need on every
task. Everything else — full architecture, API shapes, file-by-file breakdowns — lives
under `.claude/memory/`, split by topic:

| File | Covers |
|------|--------|
| `.claude/memory/backend-architecture.md` | Domain model, deterministic core (`src/core/`), agent tools, LLM provider abstraction, self-correction loop, SSE/run lifecycle, background workers, prototype stubs |
| `.claude/memory/frontend-architecture.md` | State split (TanStack Query vs Zustand), SSE consumption, three-region layout, workflow visualisation, failure state rule |
| `.claude/memory/contract-package.md` | File-by-file breakdown of `packages/contract` |
| `.claude/memory/api-contract.md` | REST/SSE endpoint shapes, error envelope |
| `.claude/memory/build-phases.md` | What each phase adds, plus completed-phase decision logs |
| `.claude/memory/key-files.md` | Quick-reference table of the most important files |

Other references: `Plans/` (original design docs, do not edit), `PHASE0_DONE.md` /
`PHASE1_DONE.md` / `PHASE4_5_DONE.md` (completed-phase decision logs and test output).
