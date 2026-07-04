# Architecture

**Demo video:** `docs/demo.webm` — recorded with Playwright against the dockerized
stack (`docker compose up`, no API keys). Covers creating a workflow from scratch
(streaming timeline + tool visibility), two edits (Slack→Teams diff, a threshold
filter), an explain turn, self-correction/repair, the two exhaustive-failure states
(validation-budget exhausted, timeout), and version history.

## The one invariant that governs everything

**The AI proposes operations. Deterministic code validates and applies them.
The AI never writes to the database directly.**

1. The agent reasons and calls read-only tools (`search_nodes`, `get_node_schema`,
   `get_current_workflow`).
2. It emits a typed **operation patch** via `propose_operations` — never raw SQL or a
   full graph replacement.
3. A deterministic validator (`apps/backend/src/core/validator.ts`, no LLM involved)
   checks catalog membership, JSON Schema config validity, DAG structure, trigger
   rules, and edge type compatibility.
4. Per PRD v1.1, a **human approval step** sits between validation and the write: the
   orchestrator emits `workflow.proposed` and pauses; only on `POST .../approve` does
   `apps/backend/src/core/version-applier.ts` write one new immutable
   `workflow_version` row.

Every module below is checked against this invariant explicitly — see each worker's
own file comment for why it either doesn't write, or writes only a lifecycle
annotation (never graph content).

## Monorepo layout

```
apps/
  backend/      Fastify API + AI orchestration + BullMQ workers (Node.js, ESM)
  frontend/     Chat UI + workflow viz (Next.js 14 App Router)
    mock/       A second, independent implementation of the same contract —
                the dev-only mock backend the frontend was originally built
                against. Kept in sync with the real backend by hand.
packages/
  contract/     Shared types, Zod schemas, the SSE event union — the API boundary
                both apps import from. Never redefined elsewhere.
infra/
  docker-compose.yml   postgres (pgvector) + redis + backend + worker + frontend
docs/
  architecture.md   this file
  api.md            REST + SSE reference
```

## Request/response shape

- **REST** for commands and reads (`apps/backend/src/routes/`).
- **SSE** (`GET /api/runs/:runId/stream`) for the AI run stream — chosen over
  WebSockets because the interaction is unidirectional push, runs over plain HTTP,
  auto-reconnects via the browser's native `EventSource`, and `Last-Event-ID` gives
  free replay semantics.
- Every SSE event carries a monotonic `seq` (assigned by `redis/seq.ts`, see below).
- Errors use a stable envelope: `{ error: { code, message, details? } }`
  (`packages/contract/src/errors.ts`'s `ErrorCode` enum).

Full endpoint-by-endpoint and event-by-event reference: `docs/api.md`.

## A run's full data flow

```
Browser                Backend (API process)         Postgres         Redis          Worker process
  |  POST .../runs          |                             |               |                |
  |------------------------>|  create run + message rows  |               |                |
  |                         |----------------------------->|               |                |
  |  {runId, messageId}     |                             |               |                |
  |<------------------------|                             |               |                |
  |                         |  agent/orchestrator.ts runs  |               |                |
  |                         |  fire-and-forget:            |               |                |
  |                         |    provider.run(ctx)         |               |                |
  |                         |    -> tool calls (search_nodes|               |                |
  |                         |       now tries pgvector      |               |                |
  |                         |       first, keyword fallback)|              |                |
  |                         |    -> propose_operations      |               |                |
  |                         |       (validates, never writes)|              |                |
  |                         |                             |               |                |
  |  GET .../stream         |                             |               |                |
  |------------------------>|  subscribeToRun (redis/      |               |                |
  |                         |  run-channel.ts) BEFORE      |               |                |
  |                         |  replay, to avoid a gap ----->|-------------->|                |
  |                         |  replay getEventsSince ------>|               |                |
  |                         |  (Postgres, sole replay       |               |                |
  |                         |   source)                    |               |                |
  |  SSE: run.started,      |                             |               |                |
  |  agent.step, tool.call, |  appendEvent: nextSeq()       |               |                |
  |  tool.result, ...       |  (Redis-atomic, redis/seq.ts) |               |                |
  |<------------------------|  -> persist to run_event ---->|               |                |
  |                         |  -> publish to run:{id} ------------------->|                |
  |  SSE: workflow.proposed |                             |               |                |
  |<------------------------|  (run pauses here — no write) |               |                |
  |  POST .../approve       |                             |               |                |
  |------------------------>|  tools/commit.ts             |               |                |
  |                         |  -> version-applier.ts       |               |                |
  |                         |     writes ONE new           |               |                |
  |                         |     workflow_version row ---->|               |                |
  |  SSE: workflow.updated, |                             |               |                |
  |  run.completed          |                             |               |                |
  |<------------------------|                             |               |                |
```

Background, off the request path (`apps/backend/src/workers/main.ts`, a separate
process from the API):

- **Embedding worker** — computes a `MockEmbedder` vector for any `node_definition`
  row missing one (deterministic, no API keys/cost) and writes it back via
  `$executeRaw ... ::vector`. This is the only writer of
  `node_definition.embedding`; it never touches a workflow or version.
- **Validation worker** — a periodic, **read-only** catalog-integrity sweep:
  re-validates every workflow's current graph against the *live* catalog (the same
  `validateGraph` used at commit time) and reports anything a catalog change has
  silently broken via the `job.lastError` column. Never writes to any workflow.
- **Archival worker** — a BullMQ repeatable (cron) job that sets
  `workflow_version.archivedAt` on versions older than `ARCHIVE_AFTER_DAYS` (default
  90, PRD v1.1 Decision #3: retain everything, never delete). A lifecycle annotation
  on an already-immutable row — never the content columns, and never through
  `version-applier.ts`. Read endpoints deliberately don't filter on it.

All three share one `Job` table (`schema.prisma`) for idempotency (`idempotencyKey`
doubles as the BullMQ `jobId`) and dead-letter bookkeeping after repeated failures.

## Reliability: providers, self-correction, failover

- **`LlmProvider`** (`providers/types.ts`) is a small streaming/tool-use interface
  modeled after Anthropic's Messages API, so a real provider is a drop-in second
  implementation. Only `MockProvider` exists today — deterministic, zero API keys,
  scripted to cover six brief scenarios and five reliability failure injections.
- **`ProviderRouter`** (`providers/router.ts`) wraps an ordered `LlmProvider[]`, each
  behind its own `CircuitBreaker` (`providers/circuit-breaker.ts`: closed → open after
  N consecutive failures → half-open trial after a cooldown). It's the composition
  root `providers/factory.ts` hands to the orchestrator, so swapping or adding a
  provider (e.g. a future `AnthropicProvider`) never touches
  `agent/orchestrator.ts`. Today it wraps a single-element list — real, tested,
  idempotent code, just idle until there's a second provider to fail over to.
- **Self-correction**: a bounded loop in `agent/orchestrator.ts`
  (`SELF_CORRECTION_BUDGET`, default 1 per PRD v1.1 Decision #2) — a failed
  `propose_operations` call emits `validation.error`, then (if budget remains)
  `retry` + `agent.step{kind:"repair"}` and re-invokes the provider with the prior
  errors; once exhausted, `run.failed` and nothing is written.

## Real-time delivery: Redis pub/sub + atomic seq

`runs/event-bus.ts` and `runs/sse.ts` used to rely on in-memory `Map`s (safe only for
a single process). They now use Redis so any number of API processes can serve the
same run's stream correctly:

- **`redis/seq.ts`** — `nextSeq(runId)` atomically seeds a run's seq counter from
  Postgres's existing max (once) and `INCR`s it — a single Lua script, race-free
  across processes.
- **`runs/run-channel.ts`** — every appended event is `PUBLISH`ed to `run:{runId}`;
  `runs/sse.ts` subscribes *before* replaying from Postgres (not after), buffering
  anything published during replay and reconciling it against the replay's last
  written `seq` — closing a small gap the original in-memory design had, not just
  moving the same behavior onto Redis.

Verified with two backend processes on different ports against the same
Postgres+Redis: a run started by process A streams correctly to a client connected
to process B, with `seq` strictly monotonic across both.

## What's deliberately not built

See `REMAINING.md` at the repo root — the one item still outstanding is a real
`AnthropicProvider` (needs a paid API key to verify; the interface is ready for it).
