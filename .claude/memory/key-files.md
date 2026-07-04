# Key files to know

Referenced from the root `CLAUDE.md`.

| Path | What it is |
|------|-----------|
| `packages/contract/src/workflow.ts` | `WorkflowGraph`, `Operation` union, `ValidationResult`, `CatalogEntry` |
| `packages/contract/src/events.ts` | Full `SseEvent` discriminated union |
| `packages/contract/src/errors.ts` | `ErrorCode` enum, `ApiErrorSchema` (Zod) |
| `packages/contract/src/api.ts` | All REST DTOs and Zod body schemas |
| `apps/backend/src/core/applier.ts` | `applyOperations` — pure, non-mutating, non-throwing |
| `apps/backend/src/core/validator.ts` | `validateGraph` — all checks, errors collected in one pass |
| `apps/backend/src/core/version-applier.ts` | `applyVersion` + `restoreVersion` — the **only** DB write paths for workflow graphs |
| `apps/backend/src/agent/orchestrator.ts` | The agent loop: self-correction budget, run deadline, cancellation, the approval-gate pause |
| `apps/backend/src/providers/mock-provider.ts` | The default `LlmProvider` — ports the mock's 6 scenarios + 5 failure injections onto the real agent loop |
| `apps/backend/src/providers/router.ts` + `circuit-breaker.ts` | `ProviderRouter` (itself an `LlmProvider`) + per-provider closed/open/half-open breaker; the composition root is `providers/factory.ts` |
| `apps/backend/src/redis/seq.ts` | Atomic, cross-process `seq` assignment for SSE events (Lua script) |
| `apps/backend/src/runs/run-channel.ts` | Redis pub/sub live event fan-out; `runs/sse.ts` subscribes before replaying from Postgres |
| `apps/backend/src/catalog/vector-search.ts` | pgvector `<=>` semantic search backing `search_nodes`, with keyword fallback |
| `apps/backend/src/workers/main.ts` | The BullMQ worker-process entrypoint (embedding, catalog-integrity validation, archival) — a separate process/compose service from the API |
| `apps/backend/src/tools/commit.ts` | The only agent-facing caller of `version-applier.ts`; reachable only from the approve route |
| `apps/backend/src/routes/runs.ts` | REST run routes incl. the approval gate (`POST .../approve`, `.../reject`) |
| `apps/backend/prisma/schema.prisma` | Full domain model; `run` carries cancellation + approval-gate columns; `node_definition.embedding`, `workflow_version.archivedAt` |
| `apps/backend/prisma/seed.ts` | Node catalog seed (5 entries) |
| `apps/backend/Dockerfile`, `apps/frontend/Dockerfile` | Multi-stage builds via `turbo prune --docker`; see both files' header comments for the gotchas worked through (tsconfig.base.json, Node version, guarded postinstall) |
| `apps/frontend/mock/server.ts` | Mock backend — every REST + SSE route incl. the approval gate, dev-only |
| `apps/frontend/mock/scenarios.ts` | The mock's scripted "AI" — scenario + failure-injection engine |
| `apps/frontend/src/stores/run-store.ts` | Zustand live-run state, scoped per conversation; `selectPendingProposal` |
| `apps/frontend/src/components/chat/ApprovalPanel.tsx` | The approve/reject UI for a pending `workflow.proposed` |
| `apps/frontend/src/lib/step-map.ts` | Pure `SseEvent[] → timeline rows` reducer |
| `apps/frontend/src/lib/dagre-layout.ts` | Pure `WorkflowGraph → positioned React Flow nodes/edges` |
| `apps/frontend/src/components/chat/FailureBanner.tsx` | The "no dead ends" failure-state banners |
| `infra/docker-compose.yml` | Full stack: Postgres (pgvector) + Redis + `backend` + `worker` + `frontend` — `docker compose up` needs no API keys |
| `docs/architecture.md` | System design, the core invariant, a run's full data flow |
| `docs/api.md` | REST + SSE reference |
| `Plans/` | Full design documents for each phase (do not edit) |
| `PHASE0_DONE.md` | Phase 0 decisions and deviations from the handover spec |
| `PHASE1_DONE.md` | Phase 1 decisions, deviations, and verbatim test output |
| `PHASE4_5_DONE.md` | Phases 4–5 (frontend) decisions, bugs found and fixed, verbatim test output |
| `REMAINING.md` | What's deliberately deferred (only `AnthropicProvider` now) and why |
| `.claude/memory/` | Detailed architecture reference — see this directory's files for anything not covered in the root `CLAUDE.md` |
