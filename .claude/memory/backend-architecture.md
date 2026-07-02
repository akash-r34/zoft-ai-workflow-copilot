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
| `run` | Lifecycle: `pending→running→succeeded/failed/cancelled/timed_out` |
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
   `workflowId` doesn't exist (Phase 2's service layer must map this to
   `WORKFLOW_NOT_FOUND`).

**Import boundary**: no file outside `src/core/` may import `version-applier.ts`.
Currently enforced by convention + a manual grep (see `PHASE1_DONE.md`); Phase 2 should
consider a real ESLint rule once a service/route layer exists.

Decisions and deviations from the original handover spec are recorded in full in
`PHASE1_DONE.md` at the repo root.

## Agent tools — Phase 2, not yet implemented

All read-only or proposing; none write.

| Tool | What it does |
|------|-------------|
| `search_nodes(query)` | pgvector similarity + keyword fallback over `node_definition` |
| `get_node_schema(type)` | Returns the `configSchema` for one node type |
| `get_current_workflow()` | Returns the current graph in compact form |
| `propose_operations(ops[])` | Runs the validator; errors returned to model, not persisted |
| `commit()` | Signals validated ops should be applied via the version applier |

## LLM provider abstraction — Phase 2, not yet implemented

`LlmProvider` interface: `stream(messages, tools, opts) → AsyncIterable<delta>`.

- `MockProvider` — default in dev and all tests; deterministic scripted responses;
  supports failure injection (bad JSON, unknown tool, hallucinated node, timeout).
- `AnthropicProvider` — enabled by `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`.
- `ProviderRouter` — circuit breaker per provider; failover order; emits
  `provider.switched` run event on failover.

Switching providers is one env var change. The mock makes the whole system run with
zero external keys.

## Self-correction loop — Phase 2, not yet implemented

Bounded ReAct-style loop. At most **3** validation-repair rounds per run. After the
budget is exhausted, the run fails cleanly with structured errors surfaced to the
user — it never loops forever or makes a partial write.

## SSE and run lifecycle — Phase 3, not yet implemented

`POST /api/conversations/:id/runs` returns `{ runId, messageId }` immediately. The
orchestrator executes async and emits `run_event` rows. Each row is pushed to the SSE
stream (`GET /api/runs/:runId/stream`) and persisted for replay. `Last-Event-ID`
replay: pass the last `seq` seen; the backend replays all `run_event` rows with a
higher `seq`, then resumes live.

## Background workers (BullMQ on Redis) — Phase 3, not yet implemented

- **Embedding generation**: fires when a `node_definition` is inserted or updated.
- **Heavy validation / external lookups**: routed off the request path.
- Worker guarantees: exponential backoff retries, dead-letter queue, idempotency keys.

## Prototype stubs (no real spend required)

- **Stripe**: `POST /api/dev/simulate/stripe-payment` emits a fake payment event.
- **Slack / Teams**: outbound actions hit an internal mock sink that logs and returns
  success.
- **LLM**: `MockProvider` runs the full demo with zero API keys. Switch to real
  Anthropic with one env var.

`docker compose up` (Phase 6 full compose) must yield a working Copilot with no
external keys configured.
