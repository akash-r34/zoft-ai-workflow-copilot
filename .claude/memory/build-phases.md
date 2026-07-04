# Build phases — detail

Referenced from the root `CLAUDE.md`. Full design documents per phase live in `Plans/`
(do not edit those — they are the original handover specs).

| Phase | What it adds | Status |
|-------|-------------|--------|
| 0 | Monorepo scaffold, contract package, Docker infra | ✅ Done |
| 1 | Prisma schema, node catalog seed, deterministic core + tests | ✅ Done |
| 2 | LLM provider abstraction, agent loop, RAG, self-correction | Next |
| 3 | SSE streaming, BullMQ workers, cancellation, circuit breaker | — |
| 4 | Frontend chat core, SSE client, activity timeline | ✅ Done (out of order, see below) |
| 5 | React Flow viz, diff highlight, version history, failure states | ✅ Done (out of order, see below) |
| 6 | Production Dockerfiles, architecture docs, API docs, demo video | — |

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

## Phase 2 (next)

Per `Plans/00-master-plan.md` / the LLM provider + agent loop plan: LLM provider
abstraction (`MockProvider`, `AnthropicProvider`, `ProviderRouter`), agent tool
registry (`search_nodes`, `get_node_schema`, `get_current_workflow`,
`propose_operations`, `commit` — see `.claude/memory/backend-architecture.md`), RAG
over the node catalog, bounded self-correction loop (max 3 repair rounds). Needs a
service-layer wrapper around `applyVersion` that loads `CatalogEntry[]` from
`node_definition` — flagged as an open question in `PHASE1_DONE.md`.

## Phases 4–5 (done, out of order)

Built ahead of the backend's Phase 2–3 (which don't exist yet — no HTTP routes, no
SSE emission), against a self-contained mock backend (`apps/frontend/mock/`) that
implements the real `packages/contract` REST + SSE surface. This is a deliberate
sequencing deviation, not a change to the backend's phase order — Phase 2 is still
the next **backend** milestone. Added:
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

## Phase 3 and 6

Not yet started. See `Plans/` for full specs:
- Phase 3: SSE streaming, BullMQ workers (embedding generation off the request path —
  this is where the `node_definition.embedding` column finally gets added), request
  cancellation, provider circuit breaker. The frontend already expects this
  contract exactly (built against a mock of it) — no frontend changes needed when
  it lands.
- Phase 6: Production Dockerfiles, architecture docs, API docs, demo video. Note:
  `apps/frontend/mock/` is dev-only and should not be containerized alongside the
  real backend.
