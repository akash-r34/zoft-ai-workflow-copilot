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
| `apps/backend/src/core/version-applier.ts` | `applyVersion` — the **only** DB write path for workflow graphs |
| `apps/backend/prisma/schema.prisma` | Full domain model (8 tables) |
| `apps/backend/prisma/seed.ts` | Node catalog seed (5 entries) |
| `apps/frontend/mock/server.ts` | Mock backend — every REST + SSE route, dev-only |
| `apps/frontend/mock/scenarios.ts` | The mock's scripted "AI" — scenario + failure-injection engine |
| `apps/frontend/src/stores/run-store.ts` | Zustand live-run state, scoped per conversation |
| `apps/frontend/src/lib/step-map.ts` | Pure `SseEvent[] → timeline rows` reducer |
| `apps/frontend/src/lib/dagre-layout.ts` | Pure `WorkflowGraph → positioned React Flow nodes/edges` |
| `apps/frontend/src/components/chat/FailureBanner.tsx` | The "no dead ends" failure-state banners |
| `infra/docker-compose.yml` | Postgres (pgvector) + Redis for local dev |
| `Plans/` | Full design documents for each phase (do not edit) |
| `PHASE0_DONE.md` | Phase 0 decisions and deviations from the handover spec |
| `PHASE1_DONE.md` | Phase 1 decisions, deviations, and verbatim test output |
| `PHASE4_5_DONE.md` | Phases 4–5 (frontend) decisions, bugs found and fixed, verbatim test output |
| `.claude/memory/` | Detailed architecture reference — see this directory's files for anything not covered in the root `CLAUDE.md` |
