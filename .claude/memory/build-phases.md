# Build phases — detail

Referenced from the root `CLAUDE.md`. Full design documents per phase live in `Plans/`
(do not edit those — they are the original handover specs).

| Phase | What it adds | Status |
|-------|-------------|--------|
| 0 | Monorepo scaffold, contract package, Docker infra | ✅ Done |
| 1 | Prisma schema, node catalog seed, deterministic core + tests | ✅ Done |
| 2 | LLM provider abstraction, agent loop, RAG, self-correction | ✅ Done (core) — see below; advanced pieces in `REMAINING.md` |
| 3 | SSE streaming, BullMQ workers, cancellation, circuit breaker | ✅ Done (core) — see below; advanced pieces in `REMAINING.md` |
| 4 | Frontend chat core, SSE client, activity timeline | ✅ Done (out of order, see below) |
| 5 | React Flow viz, diff highlight, version history, failure states | ✅ Done (out of order, see below) |
| 6 | Production Dockerfiles, architecture docs, API docs, demo video | — (see `REMAINING.md`) |

**PRD v1.1 addition, built alongside Phase 2–3 (core):** the mandatory human
approval gate (Decision #1) — see the dedicated section below.

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

Advanced Phase 2–3 pieces (real `AnthropicProvider`, a real `ProviderRouter`
circuit breaker, pgvector RAG + embedding worker, BullMQ workers + Redis pub/sub +
DLQ/idempotency, version archival) are deliberately deferred — see `REMAINING.md`
for the full list and rationale.

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

## Phase 6

Not yet started. See `Plans/05-deliverables.md` for the full spec: production
Dockerfiles, architecture docs, API docs, demo video. Note: `apps/frontend/mock/`
is dev-only and should not be containerized alongside the real backend. Full list
of what's deferred and why: `REMAINING.md` at repo root.
