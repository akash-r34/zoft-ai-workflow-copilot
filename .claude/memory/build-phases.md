# Build phases — detail

Referenced from the root `CLAUDE.md`. Full design documents per phase live in `Plans/`
(do not edit those — they are the original handover specs).

| Phase | What it adds | Status |
|-------|-------------|--------|
| 0 | Monorepo scaffold, contract package, Docker infra | ✅ Done |
| 1 | Prisma schema, node catalog seed, deterministic core + tests | ✅ Done |
| 2 | LLM provider abstraction, agent loop, RAG, self-correction | ✅ Done — see below; only `AnthropicProvider` itself remains, in `REMAINING.md` |
| 3 | SSE streaming, BullMQ workers, cancellation, circuit breaker | ✅ Done — see below |
| 4 | Frontend chat core, SSE client, activity timeline | ✅ Done (out of order, see below) |
| 5 | React Flow viz, diff highlight, version history, failure states | ✅ Done (out of order, see below) |
| 6 | Production Dockerfiles, architecture docs, API docs, demo video | ✅ Done — see below |

**PRD v1.1 addition, built alongside Phase 2–3 (core):** the mandatory human
approval gate (Decision #1) — see the dedicated section below.

**Two build passes on the backend:** the first (below, "Phase 2–3 (core)")
built the real backend end-to-end with the deterministic `MockProvider` — real
REST+SSE, real agent loop, the approval gate — deliberately deferring
pgvector/BullMQ/Redis-pub-sub/circuit-breaker/Phase 6 as documented advanced work.
The second pass ("Phase 2–3 (advanced) + Phase 6", further below) built all of
that deferred work. `AnthropicProvider` is the one item still not built, by
deliberate choice (needs a paid API key) — see `REMAINING.md`.

## Phase 0 (done)

Scaffold: pnpm + Turborepo monorepo, `apps/backend` (Fastify, empty beyond bootstrap),
`apps/frontend` (Next.js 14 App Router), `packages/contract`, Docker infra
(Postgres w/ pgvector + Redis), strict TypeScript, Vitest wired in both apps. Full
decision log and deviations: `PHASE0_DONE.md` at repo root.

## Phase 1 (done)

Started from commit `d3e3fec`. Added:
- `apps/backend/prisma/schema.prisma` — full domain schema (see
  `.claude/memory/backend-architecture.md`), migrated as `20260702141854_init`
- `apps/backend/prisma/seed.ts` — the five node catalog entries
- `apps/backend/src/core/` — `types.ts`, `applier.ts`, `validator.ts`,
  `version-applier.ts`, `index.ts`
- `apps/backend/src/core/__tests__/` — 25 Vitest tests (unit, property via fast-check,
  guarded real-DB integration)

Touched **nothing** in `packages/contract` or `apps/frontend` — every type Phase 1
needed already existed in the contract. Full decision log, deviations from the
handover spec, and verbatim test output: `PHASE1_DONE.md` at repo root. Notably: the
`node_definition.embedding` (pgvector) column was deliberately deferred to Phase 3
rather than added in the `init` migration.

## Phase 2–3 (done, core) + the PRD v1.1 approval gate

Built a real, Postgres-backed Fastify backend that the existing frontend (Phases
4–5) runs against unchanged — no frontend behavior change beyond the approval-gate
UI described below. Added under `apps/backend/src/`:

- `config/env.ts` — zod-validated env (`SELF_CORRECTION_BUDGET` default 1 per PRD
  v1.1 Decision #2, `RUN_DEADLINE_MS`, `APPROVAL_REQUIRED` default true, `LLM_PROVIDER`)
- `catalog/catalog-service.ts` — loads/searches the seeded node catalog
- `dto/mappers.ts`, `dto/diff.ts` — Prisma row → `@zoft/contract` DTOs, graph diffing
- `providers/types.ts`, `providers/mock-provider.ts`, `providers/factory.ts` — the
  `LlmProvider` abstraction (shaped after Anthropic's streaming/tool-use API so a
  real provider is a drop-in second implementation) and the default, zero-key
  `MockProvider`, which ports `apps/frontend/mock/scenarios.ts`'s six scenarios +
  five failure injections into a provider that drives the **real** agent loop and
  **real** validator, not a fake
- `tools/` — `read-tools.ts` (search_nodes, get_node_schema, get_current_workflow),
  `propose-operations.ts` (validates via the real core, never writes),
  `commit.ts` (the only agent-facing caller of `core/version-applier.ts`),
  `registry.ts` (dispatch + the "unknown tool" reliability check)
- `agent/orchestrator.ts` — the bounded self-correction loop, run deadline race,
  cancellation checks, and the approval-gate pause (see below)
- `runs/event-bus.ts`, `runs/sse.ts`, `runs/run-service.ts` — persisted,
  replayable (`Last-Event-ID`) SSE event log; run/message lifecycle
- `routes/*` — the full REST surface, byte-compatible with
  `apps/frontend/mock/server.ts`'s responses and error envelope
- `core/version-applier.ts` gained `restoreVersion` (re-saves an earlier version
  verbatim through the same single writer, re-validating first) — the only other
  addition to that file; `applyVersion` itself is unchanged in behavior

**The approval gate (PRD v1.1 Decision #1):** the orchestrator validates a
candidate change via `propose_operations` but does not commit — it emits
`workflow.proposed` (new SSE event, `packages/contract/src/events.ts`) and pauses
(run stays `running`, kept alive by heartbeats) until `POST /api/runs/:id/approve`
or `/reject` (new endpoints, `packages/contract/src/api.ts`) resolves it. Approve
calls `tools/commit.ts` (writes exactly one new version); reject discards the
proposal and persists an assistant message, writing nothing. This required
coordinated changes across all four packages: `packages/contract` (the new
event + DTOs), `apps/backend` (the pause/resume + two routes), `apps/frontend/mock`
(kept as a faithful peer — same pause/approve/reject behavior, in-memory), and
`apps/frontend/src` (a new `ApprovalPanel` component, `useApproveRun`/`useRejectRun`
hooks, and a `selectPendingProposal` selector in `stores/run-store.ts`).

Verified end-to-end against the real backend: unit tests (Vitest, incl. a full
`MockProvider` scenario-by-scenario suite), DB integration tests (Prisma against
the Docker Postgres), and a 33-check HTTP/SSE script covering all six scenarios,
all five failure injections, the approval gate (including double-approve/
double-reject), cancellation mid-flight, `Last-Event-ID` reconnect/replay, and
REST error/edge cases.

At the time this pass shipped, advanced Phase 2–3 pieces (a real `ProviderRouter`
circuit breaker, pgvector RAG + embedding worker, BullMQ workers + Redis pub/sub +
DLQ/idempotency, version archival) were deliberately deferred. **All of that has
since been built** — see the next section.

## Phase 2–3 (advanced) + Phase 6 — done

Built out everything `REMAINING.md` had cataloged as deferred, except
`AnthropicProvider` itself (needs a paid API key — see `REMAINING.md`). No
frontend changes anywhere in this pass; no contract changes either — this is
entirely backend-internal + infra. Verified with the existing 33-check
`e2e-check.mjs` and 22-screenshot Playwright suite re-run against both the local
stack and the fully dockerized one, plus a genuine two-process test proving
cross-process SSE fan-out. Added under `apps/backend/src/`:

- **`redis/connection.ts`, `redis/seq.ts`** — three Redis connection roles
  (general-purpose/pub-sub, one dedicated connection per SSE subscriber, one
  shared BullMQ connection) and an atomic, Lua-script `nextSeq(runId)` that
  seeds a run's seq counter from Postgres's existing max exactly once, then
  `INCR`s it — race-free across any number of backend processes.
- **`runs/run-channel.ts`** — Redis pub/sub for a run's live event fan-out,
  replacing `event-bus.ts`'s old in-process `Map<runId, Set<listener>>`.
  `runs/sse.ts` now **subscribes before replaying** from Postgres (not after),
  buffering anything published mid-replay and reconciling it by `seq` — closing
  a small gap the original in-memory design had, not just relocating the same
  behavior onto Redis. Postgres (`event-bus.ts`'s `appendEvent`/`getEventsSince`)
  remains the sole persisted replay source, completely unchanged.
- **`queues/`** (`queue-names.ts`, `job-store.ts`, `queues.ts`) — BullMQ
  scaffolding: typed enqueue helpers that write a `Job` row (`idempotencyKey`
  doubles as the BullMQ `jobId`, so re-enqueuing the same logical job is a no-op
  on both sides) before calling `queue.add`. idempotencyKeys use `-`, never `:`
  (BullMQ rejects a `:` in `jobId`).
- **`embeddings/`** (`embedder.ts`, `mock-embedder.ts`, `serialize.ts`) +
  **`catalog/vector-search.ts`** — a deterministic, zero-cost `MockEmbedder`
  (feature-hashed bag-of-words, L2-normalized, `EMBEDDING_DIM=256`) and a real
  pgvector `<=>` cosine-distance query (`node_definition.embedding
  vector(256)`, added via migration — Prisma's `Unsupported("vector(256)")`
  since it has no native vector type). `tools/read-tools.ts`'s `search_nodes`
  tries this first, falling back to the existing keyword search — verified to
  actually change ranking behavior, not just silently no-op (a natural-language
  query now ranks catalog types semantically instead of alphabetically).
- **`workers/`** — `embedding-worker.ts` (the only writer of
  `node_definition.embedding`; backfills on worker boot via
  `enqueueMissingEmbeddings`), `validation-worker.ts` (a periodic, **read-only**
  catalog-integrity sweep — re-validates every workflow's current graph against
  the *live* catalog and reports via `job.lastError`; never writes to a
  workflow), `archival-worker.ts` (a BullMQ repeatable/cron job that sets
  `workflow_version.archivedAt` — never the content columns, never through
  `version-applier.ts` — on versions older than `ARCHIVE_AFTER_DAYS`, default
  90; PRD v1.1 Decision #3), `main.ts` (the worker-process entrypoint, a
  separate process/compose service from the API).
- **`providers/circuit-breaker.ts`, `providers/router.ts`** — a real
  closed/open/half-open breaker per provider and a `ProviderRouter` that itself
  implements `LlmProvider`, so `agent/orchestrator.ts`'s single
  `provider.run(ctx)` call site needed zero changes.
  `providers/factory.ts`'s `getProvider()` is now the composition root,
  returning `new ProviderRouter([new MockProvider()])` — one element today, so
  the breaker is real, tested, working code, just idle until a second provider
  exists to fail over to.
- **Schema additions**: `NodeDefinition.embedding`, `WorkflowVersion.archivedAt`
  — both applied via manually-written migrations + `prisma migrate deploy`
  rather than `migrate dev`, because Prisma's shadow database (used for
  `migrate dev`'s validation) doesn't have the `vector` extension enabled, the
  same pgvector/shadow-DB friction noted back in `PHASE1_DONE.md`.
- **Phase 6 packaging**: `apps/backend/Dockerfile` + `docker-entrypoint.sh`,
  `apps/frontend/Dockerfile` (Next.js `output: "standalone"`), root
  `.dockerignore`, `backend`/`worker`/`frontend` services added to
  `infra/docker-compose.yml`. Both Dockerfiles use Turborepo's own `turbo prune
  --docker` (this repo already runs on Turborepo). Real gotchas worked through
  here, worth knowing before touching either Dockerfile again: `turbo prune`
  doesn't carry along `tsconfig.base.json`/`.eslintrc.base.json` (not part of
  any package's own dependency graph — copied in explicitly from the pruner
  stage); the repo's pinned `pnpm@11.9.0` needs Node ≥22.13 despite
  `engines.node` saying `>=20.0.0` (both Dockerfiles use `node:22-slim`); and
  `apps/backend/package.json`'s `postinstall` had to become conditional
  (`test -f prisma/schema.prisma && ... || true`) since it fires during
  `turbo prune`'s partial-install stage, before the schema file is present.
  Verified with a genuine clean-slate test: `docker compose down -v` then
  `docker compose up -d --build` from zero, migrations + seed running
  automatically, a full scenario driven through the dockerized stack via curl
  and via a real browser (Playwright).
- **`docs/architecture.md`, `docs/api.md`, `docs/demo.webm`** — written to
  match what's actually implemented, not aspirational; the demo video was
  recorded with Playwright's built-in video capture against the dockerized
  stack, no external tools.

## Phases 4–5 (done, out of order)

Built ahead of the backend's Phase 2–3 (which didn't exist at the time — no HTTP
routes, no SSE emission), against a self-contained mock backend
(`apps/frontend/mock/`) that implements the real `packages/contract` REST + SSE
surface. This was a deliberate sequencing deviation, not a change to the backend's
phase order; Phase 2–3 (core) has since landed (see above) and the frontend runs
against it unchanged, modulo the approval-gate UI added alongside that work. Added:
- `apps/frontend/mock/server.ts`, `apps/frontend/mock/scenarios.ts` — the mock
  backend and its scripted "AI" (keyword-driven scenario engine covering all six
  brief scenarios and five failure injections)
- `apps/frontend/src/lib/`, `stores/`, `hooks/` — API client, SSE client, the
  Zustand run store (scoped per-conversation), the pure timeline/layout reducers
- `apps/frontend/src/components/` — three-region `Workspace`, chat pane with
  activity timeline and failure banners, React Flow + dagre workflow panel with
  diff highlighting, version history, conversation sidebar, dark mode
- `apps/frontend/src/__tests__/` — 29 Vitest tests for the three pure-logic modules

Full decision log, deviations, five real bugs found via Playwright-driven testing
(not caught by typecheck/lint), and verbatim test output: `PHASE4_5_DONE.md` at repo
root. Detail on the implemented architecture: `.claude/memory/frontend-architecture.md`.
Nothing in `apps/frontend/src` imports from `apps/frontend/mock/` — swapping to the
real backend is a `NEXT_PUBLIC_API_URL` change only.

## Phase 6 — done

See "Phase 2–3 (advanced) + Phase 6" above for the Dockerfile/compose/docs detail.
`apps/frontend/mock/` is correctly excluded from the frontend's production image
(the Dockerfile only builds `@zoft/frontend`, not the mock) and was not touched by
this pass. The `Plans/05-deliverables.md` acceptance criterion — clean checkout →
`docker compose up` → a working Copilot, no API keys — is satisfied and was
verified with an actual `docker compose down -v && docker compose up -d --build`
from zero. The one thing this doesn't cover: `AnthropicProvider` — see
`REMAINING.md`.
