# Remaining work

This tracks what is intentionally **not** built yet, as of the backend Phase 2/3
core build + PRD v1.1 approval gate (see `.claude/memory/build-phases.md` for the
full decision log of what *was* built in that pass).

The guiding scope decision: build the smallest real backend that makes the
**existing, unmodified** frontend chat/timeline/workflow UI work end-to-end against
a real Postgres-backed Fastify server — real REST + SSE, the real deterministic
core (`apps/backend/src/core/`), a real (if scripted) agent loop, and the
PRD v1.1-mandated human approval gate. Everything below is explicitly deferred,
not silently dropped.

---

## Backend Phase 2 — advanced pieces

- **`AnthropicProvider`** — a real `@anthropic-ai/sdk`-backed `LlmProvider`
  (`apps/backend/src/providers/types.ts`'s interface is already shaped after the
  Anthropic streaming/tool-use API for exactly this reason). Gated behind
  `LLM_PROVIDER=anthropic`; currently `providers/factory.ts` throws a clear error
  if that env is set, rather than silently falling back to the mock. Before
  writing it: consult the `claude-api` skill for current model ids (default
  should be `claude-opus-4-8`), tool-definition shape, and streaming event names.
- **`ProviderRouter` + a real circuit breaker** — today, provider failover for the
  "provider unavailable" reliability scenario is simulated: `MockProvider` itself
  emits a `provider_switch` delta for one demo keyword. A real router would sit in
  front of an ordered provider list, trip open after N consecutive `ProviderError`s
  from any one provider, and route to the next — needed once `AnthropicProvider`
  exists and can genuinely fail (rate limits, outages).
- **RAG over the node catalog via pgvector** — `search_nodes` currently does a
  keyword/ILIKE-style match (`catalog/catalog-service.ts`'s `searchCatalog`), which
  is sufficient for the current 5-entry seed catalog. The `node_definition.embedding
  vector(1536)` column is still deferred (as it was after Phase 1 — see
  `PHASE1_DONE.md`), along with an embedding worker and a real embedder (Anthropic
  has no embeddings endpoint, so this needs a separate provider, e.g. Voyage AI, or
  a deterministic `MockEmbedder` for keyless demos).
- **Self-correction budget tuning** — implemented and configurable
  (`SELF_CORRECTION_BUDGET`, default `1` per PRD v1.1 Decision #2), but only
  exercised against the deterministic MockProvider's scripted failure modes, not
  against genuine model unpredictability.

## Backend Phase 3 — advanced pieces

- **BullMQ workers** — no background job queue exists yet. Heavy validation and
  embedding generation both currently run inline on the request path (fine at
  this scale; the `Job` table and `JobStatus` enum in `schema.prisma` are already
  modeled for when this changes). Needed: `workers/embedding-worker.ts`,
  `workers/validation-worker.ts`, exponential backoff, a dead-letter queue, and
  idempotency-key deduplication on enqueue.
- **Redis pub/sub bridge for SSE** — `runs/event-bus.ts`'s subscriber map is
  in-process only (documented in that file). This is correct for a single backend
  instance but does not fan out across multiple API processes; that requires
  publishing every event to a Redis channel (`run:{runId}`) and having each SSE
  connection subscribe to it instead of the in-memory `Map`.
- **`seq` assignment is an in-memory per-run counter**, not a DB-transactional or
  Redis-atomic one (also documented in `event-bus.ts`). Safe today because exactly
  one orchestrator process ever emits events for a given run, but would need to
  change for horizontal scaling.
- **Version retention / archival job** (PRD v1.1 Decision #3: keep all versions,
  archive those older than 90 days) — not implemented; every version is retained
  indefinitely with no archival path yet.

## The approval gate (PRD v1.1 Decision #1) — what's built vs. simplified

Built: the full gate — `workflow.proposed` SSE event, `POST /api/runs/:id/approve`
and `/reject`, the `run.proposedOps`/`proposedGraph`/`proposalSummary`/
`proposalStatus` columns, and the frontend's `ApprovalPanel` — across the contract,
real backend, mock backend, and frontend, all verified end-to-end (see
`.claude/memory/build-phases.md`).

Not built: any approval **history/audit view** beyond the version's own
`changeSummary` (e.g. "who approved this and when" as a first-class record — today
that's implicitly just "there's a new `workflow_version` row, created by `ai`,
after a `POST /approve` call succeeded").

## Phase 6 — not started

- Production Dockerfiles for `apps/backend` and `apps/frontend`, and corresponding
  services in `infra/docker-compose.yml` (which today only runs Postgres + Redis
  for local dev).
- `docs/architecture.md`, `docs/api.md` (only `docs/skills-report.md` exists).
- Demo video.
- The "clean checkout → `docker compose up` → fully working Copilot, no API keys"
  acceptance criterion from `Plans/05-deliverables.md` is therefore **not yet
  satisfiable** — running the real backend today requires a manual
  install/migrate/seed/dev sequence (see `apps/backend/package.json` scripts and
  `CLAUDE.md`'s development commands).

## Known simplifications worth flagging (not blockers, just honesty)

- `workflow.ownerId` is hardcoded to a fixed `"dev-user"` string — there is no
  authentication/authorization layer.
- `MockProvider`'s scenario selection is keyword-based (mirrors the mock backend's
  original design), not semantic intent classification. It's grounded in the real
  node catalog via `search_nodes` before deciding what to propose, but the initial
  routing decision itself is a regex match on the user's message.
- The real backend and `apps/frontend/mock/` are two independent implementations
  of the same contract (by design — the mock predates the real backend and must
  keep working standalone). Keeping their behavior in sync when the contract
  changes again is a manual discipline, not enforced by a shared implementation.
