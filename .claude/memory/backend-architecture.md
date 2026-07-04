# `apps/backend` — architecture detail

Referenced from the root `CLAUDE.md`. See also `.claude/memory/key-files.md` and
`.claude/memory/build-phases.md`.

## Domain model (Prisma + Postgres)

| Table | Purpose |
|-------|---------|
| `workflow` | Root entity; holds pointer (`currentVersionId`) to current version |
| `workflow_version` | **Immutable append-only**; stores `graph` as JSONB, `createdBy`, `changeSummary`, `parentVersionId` |
| `node_definition` | Data-driven catalog; `type` is PK; `configSchema` (JSONB JSON Schema); `embedding` (vector) — deferred to Phase 3, see build-phases.md |
| `conversation` | Chat session; links to a workflow once one exists |
| `message` | User/assistant messages; `runId` links to the run that produced an AI turn |
| `run` | Lifecycle: `pending→running→succeeded/failed/cancelled/timed_out`. Also carries `cancelRequested` and the approval-gate columns `proposedOps`/`proposedGraph`/`proposalSummary`/`proposalStatus` (added in the Phase 2–3 core build — see build-phases.md) |
| `run_event` | Persisted SSE trace; `seq` is monotonic per run; backs replay and the frontend timeline |
| `job` | Background job bookkeeping for BullMQ workers; `idempotencyKey` unique, `attempts`/`lastError` for retry tracking |

Adding new workflow node types = inserting a row into `node_definition`. No redeploy.

`workflow` ↔ `workflow_version` is a cyclic FK (workflow points at its current version;
each version points back at its workflow). Modeled in Prisma as two named relations
(`WorkflowVersions` list, `CurrentVersion` one-to-one) — both sides must be declared.
`currentVersionId` cascades `ON DELETE SET NULL`; `workflow_version.workflowId` cascades
`ON DELETE RESTRICT`.

## Deterministic core (`src/core/`) — implemented, Phase 1

Pure functions, no I/O except the version applier. Fully unit-tested (Vitest).
`vitest.config.ts` coverage is scoped to `src/core/**`.

1. **`types.ts`** — re-exports `WorkflowNode`, `WorkflowEdge`, `WorkflowGraph`,
   `EMPTY_GRAPH`, `Operation`, `ValidationError`, `ValidationResult`, `CatalogEntry`
   from `@zoft/contract`. Does not redefine them — see the contract rule in the root
   `CLAUDE.md`.
2. **`applier.ts`** — `applyOperations(graph, ops[]) → candidateGraph`. Pure, never
   mutates input, never throws. Ops referencing missing ids are skipped (validator
   catches the resulting structural problems, e.g. dangling edges). `remove_node` does
   **not** cascade-delete connected edges. `update_node_config` **replaces** the config
   object wholesale (not a deep merge); use `set_node_config_field` for a single
   nested-path edit.
3. **`validator.ts`** — `validateGraph(graph, catalog[]) → ValidationResult`. Runs all
   checks and collects every error in one pass (never short-circuits): catalog
   membership (`UNKNOWN_NODE_TYPE`), Ajv config schema (`INVALID_CONFIG`), structure
   (`TRIGGER_COUNT`, `CYCLE_DETECTED`, `DANGLING_EDGE`, `ORPHAN_NODE`), edge type
   compatibility (`TYPE_MISMATCH`), trigger rules (`TRIGGER_HAS_INBOUND`). An empty
   graph (`nodes: []`) is valid — every workflow starts from `EMPTY_GRAPH`.
4. **`version-applier.ts`** — `applyVersion(prisma, workflowId, ops, catalog, createdBy,
   changeSummary)`. The **only** function in the codebase that writes a workflow graph.
   Wraps in `prisma.$transaction`: loads current graph (or `EMPTY_GRAPH` if
   `currentVersionId` is null) → `applyOperations` → `validateGraph` → on failure,
   returns `{ error }` with zero writes; on success, inserts one `workflow_version` row
   and updates `workflow.currentVersionId`, returning `{ version, graph }`. Throws if
   `workflowId` doesn't exist (mapped to `WORKFLOW_NOT_FOUND` at the route layer —
   see `routes/runs.ts`'s approve handler). Also exports **`restoreVersion`** (added in
   the Phase 2–3 core build): re-saves an existing version's graph verbatim as a new
   version, re-validating first — the deterministic write path behind
   `POST /api/workflows/:id/versions/:v/restore`. Same file, same single-writer rule.

**Import boundary**: no file outside `src/core/` may import `version-applier.ts`,
**except** `src/tools/commit.ts` — the one agent-facing caller, itself only reachable
from `routes/runs.ts`'s `POST .../approve` handler (i.e. only after a human approves).
Enforced by convention, not an ESLint rule.

Decisions and deviations from the original handover spec are recorded in full in
`PHASE1_DONE.md` at the repo root.

## Agent tools — implemented (Phase 2 core)

All read-only or proposing; none write except `commit`, which is only ever invoked
from the approve route handler, never from the agent loop directly.

| Tool | File | What it does |
|------|------|-------------|
| `search_nodes(query)` | `tools/read-tools.ts` | Keyword/ILIKE-style match over `node_definition` (pgvector similarity search is deferred — see `REMAINING.md`) |
| `get_node_schema(type)` | `tools/read-tools.ts` | Returns the `configSchema` for one node type |
| `get_current_workflow()` | `tools/read-tools.ts` | Returns the current graph in compact form |
| `propose_operations(ops[])` | `tools/propose-operations.ts` | Runs `applyOperations` + `validateGraph`; errors returned to the caller, nothing persisted |
| `commit` | `tools/commit.ts` | Thin wrapper around `core/version-applier.ts`'s `applyVersion` — the only write path |

`tools/registry.ts` dispatches by name; an unrecognized tool name returns a normal
`{ ok: false }` result (reliability failure mode #3) rather than throwing.

## LLM provider abstraction — implemented (Phase 2 core, MockProvider only)

`LlmProvider` interface (`providers/types.ts`): `run(ctx: TurnContext) →
AsyncIterable<ProviderDelta>`, where `ProviderDelta` is `text | tool_use | finish |
provider_switch` — modeled after the Anthropic streaming/tool-use API shape so a real
provider is a drop-in second implementation.

- **`MockProvider`** (`providers/mock-provider.ts`) — the default and, currently, the
  only implementation. Zero API keys. Ports `apps/frontend/mock/scenarios.ts`'s
  keyword-driven scenario selection (six brief scenarios + five failure injections)
  into a provider that drives the **real** agent loop, tools, and validator — not a
  fake. Failure injections: hallucinated node type (`fail`), invalid config
  (`self_correct`), a synthetic `provider_switch` delta (`provider`, simulating
  router failover — see below), a `_simulateFailure` fault hook on `search_nodes`
  (`tool`), and a deliberately-never-resolving generator (`timeout`, raced against
  the orchestrator's real deadline).
- **`AnthropicProvider`** — **not implemented**. `providers/factory.ts` throws a clear
  error if `LLM_PROVIDER=anthropic` is set, rather than silently falling back. See
  `REMAINING.md`.
- **`ProviderRouter`** with a real circuit breaker — **not implemented**. The
  "provider unavailable → failover" reliability scenario is currently simulated by
  `MockProvider` itself emitting a `provider_switch` delta for one demo keyword; a
  real router sitting in front of an ordered provider list is deferred until
  `AnthropicProvider` exists and can genuinely fail. See `REMAINING.md`.

Switching to a real provider is still meant to be one env var change
(`LLM_PROVIDER=anthropic`) once `AnthropicProvider` is built — the interface is
already shaped for it.

## Self-correction loop — implemented (Phase 2 core)

Bounded loop in `agent/orchestrator.ts`. Budget is `SELF_CORRECTION_BUDGET`
(env, **default 1** per PRD v1.1 Decision #2 — note this supersedes the original
plan's "start with 3"; set the env higher to restore that behavior for a demo).
Each failed `propose_operations` call emits `validation.error`, then — if budget
remains — `retry` + `agent.step{kind:"repair"}` and re-invokes the provider with the
prior errors; once exhausted, emits `run.failed` and writes nothing.

## The approval gate (PRD v1.1 Decision #1) — implemented

Added alongside Phase 2–3 core, not originally in the phase plan. Once
`propose_operations` validates, the orchestrator does **not** call `commit` itself —
it emits `workflow.proposed` (new SSE event carrying the candidate graph, diff, and
summary) and pauses; the run stays `running`, kept alive by heartbeats, with the
proposal stashed on the `run` row (`proposedOps`/`proposedGraph`/`proposalSummary`/
`proposalStatus: "pending"`). `POST /api/runs/:id/approve` calls `tools/commit.ts`
(re-validating against whatever is then current) and emits `workflow.updated` +
`run.completed`; `POST /api/runs/:id/reject` discards it, persists an assistant
message, and emits `run.completed` — writing nothing. Guarded by `APPROVAL_REQUIRED`
(default `true`); setting it `false` restores immediate auto-commit, useful for
tests that don't want to simulate the extra HTTP round trip.

## SSE and run lifecycle — implemented (Phase 3 core)

`POST /api/conversations/:id/runs` (`routes/conversations.ts` → `runs/run-service.ts`)
returns `{ runId, messageId }` immediately; the orchestrator runs fire-and-forget.
`runs/event-bus.ts` assigns each event a monotonic `seq` (an **in-memory per-run
counter**, safe because exactly one orchestrator process ever emits for a given run
— see `REMAINING.md` for what horizontal scaling would need instead) and persists it
to `run_event`. `runs/sse.ts` (`GET /api/runs/:runId/stream`) replays every
`run_event` with `seq` greater than the `Last-Event-ID` header, then subscribes to
live events, with a 15s heartbeat — byte-compatible with
`apps/frontend/mock/server.ts`'s stream route. Cancellation: `POST .../cancel` sets
`run.cancelRequested`; the orchestrator's per-step `tick()` helper checks it between
steps and emits `run.cancelled` instead of continuing.

## Background workers (BullMQ on Redis) — not implemented

Deferred — see `REMAINING.md`. Heavy validation and embedding generation both
currently run inline on the request path (fine at this catalog size). The `Job`
table and `JobStatus` enum are already modeled in `schema.prisma` for when this
changes: exponential backoff retries, dead-letter queue, idempotency keys.

## Prototype stubs (no real spend required)

- **Stripe**: `POST /api/dev/simulate/stripe-payment` emits a fake payment event
  (implemented in the real backend, `routes/dev.ts` — previously only in the mock).
- **Slack / Teams**: outbound actions are never actually sent; the graph just
  records the intended message config.
- **LLM**: `MockProvider` runs the full demo with zero API keys. Switching to real
  Anthropic still needs `AnthropicProvider` built first (see above).

`docker compose up` today starts Postgres + Redis only (`infra/docker-compose.yml`);
containerizing the backend/frontend themselves is Phase 6, not yet started.
