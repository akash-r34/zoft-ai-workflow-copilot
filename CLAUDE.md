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
is a deliberate, reviewable edit to `packages/contract` first.

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

## `packages/contract` — what lives here

The enforced seam between the two teams. Contains:

- `workflow.ts` — `WorkflowNode`, `WorkflowEdge`, `WorkflowGraph`, `EMPTY_GRAPH`,
  `Operation` union, `ValidationError`, `ValidationResult`, `CatalogEntry`
- `events.ts` — `SseEvent` discriminated union (keyed on `event`), `AgentStepKind`,
  `WorkflowDiff`
- `errors.ts` — `ApiErrorSchema` (Zod), `ErrorCode` enum, `ErrorEnvelope`
- `api.ts` — all REST request/response DTOs and Zod body schemas
- `index.ts` — re-exports everything with `.js` specifiers (NodeNext ESM)

**Add a field to the contract before writing code that depends on it.** The contract
is the source of truth, not the app code.

---

## `apps/backend` — key architecture

### Domain model (Prisma + Postgres)

| Table | Purpose |
|-------|---------|
| `workflow` | Root entity; holds pointer to current version |
| `workflow_version` | **Immutable append-only**; stores `graph` as JSONB, `createdBy`, `changeSummary`, `parentVersionId` |
| `node_definition` | Data-driven catalog; `type` is PK; `configSchema` (JSONB JSON Schema); `embedding` (vector) |
| `conversation` | Chat session; links to a workflow once one exists |
| `message` | User/assistant messages; `runId` links to the run that produced an AI turn |
| `run` | Lifecycle: `pending→running→succeeded/failed/cancelled/timed_out` |
| `run_event` | Persisted SSE trace; `seq` is monotonic per run; backs replay and the frontend timeline |

Adding new workflow node types = inserting a row into `node_definition`. No redeploy.

### Deterministic core (`src/core/`)

Pure functions, no I/O, fully unit-tested. Three components:

1. **Applier** — `applyOperations(graph, ops[]) → candidateGraph`. Deterministic, no side effects.
2. **Validator** — checks catalog membership, Ajv config schemas, DAG structure, trigger
   rules, edge type compatibility. Returns `ValidationResult`.
3. **Version applier** — the **only** code path that writes a workflow graph. Wraps in a
   transaction: insert `workflow_version`, update `workflow.currentVersionId`.

Cover `src/core/` with Vitest unit and property tests. This is where correctness lives.

### Agent tools (all read-only or proposing, none write)

| Tool | What it does |
|------|-------------|
| `search_nodes(query)` | pgvector similarity + keyword fallback over `node_definition` |
| `get_node_schema(type)` | Returns the `configSchema` for one node type |
| `get_current_workflow()` | Returns the current graph in compact form |
| `propose_operations(ops[])` | Runs the validator; errors returned to model, not persisted |
| `commit()` | Signals validated ops should be applied via the version applier |

### LLM provider abstraction

`LlmProvider` interface: `stream(messages, tools, opts) → AsyncIterable<delta>`.

- `MockProvider` — default in dev and all tests; deterministic scripted responses;
  supports failure injection (bad JSON, unknown tool, hallucinated node, timeout).
- `AnthropicProvider` — enabled by `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`.
- `ProviderRouter` — circuit breaker per provider; failover order; emits
  `provider.switched` run event on failover.

Switching providers is one env var change. The mock makes the whole system run
with zero external keys.

### Self-correction loop

Bounded ReAct-style loop. At most **3** validation-repair rounds per run. After
the budget is exhausted, the run fails cleanly with structured errors surfaced to
the user — it never loops forever or makes a partial write.

### SSE and run lifecycle

`POST /api/conversations/:id/runs` returns `{ runId, messageId }` immediately.
The orchestrator executes async and emits `run_event` rows. Each row is pushed
to the SSE stream (`GET /api/runs/:runId/stream`) and persisted for replay.
`Last-Event-ID` replay: pass the last `seq` seen; the backend replays all
`run_event` rows with a higher `seq`, then resumes live.

### Background workers (BullMQ on Redis)

- **Embedding generation**: fires when a `node_definition` is inserted or updated.
- **Heavy validation / external lookups**: routed off the request path.
- Worker guarantees: exponential backoff retries, dead-letter queue, idempotency keys.

---

## `apps/frontend` — key architecture

### State split (strict separation)

- **TanStack Query** — server state: conversations, messages, workflow, version list.
  Cached, refetchable, source of truth for persisted data.
- **Zustand** — live run state: active `runId`, ordered event list, token buffers,
  connection status. Ephemeral UI state only.

Never mix these. Live streaming state goes to Zustand; anything that should survive
a page refresh goes through TanStack Query.

### SSE consumption

Reduce events into the Zustand run store **by `seq`**. Rendering is a pure function
of the ordered event list. On reconnect send `Last-Event-ID: <last seq seen>`.
A heartbeat event absence flips the UI to "reconnecting".

### Three-region layout

- **Chat pane** (center-left) — conversation, streaming tokens, input.
- **Agent activity timeline** (attached to the in-flight turn) — collapsible rows
  per step, expandable for tool input/result/timing.
- **Workflow panel** (right) — React Flow graph, diff highlighting on
  `workflow.updated`, version history control.

### Workflow visualisation

React Flow, read-mostly. Auto-layout (dagre, left-to-right). No manual dragging.
On `workflow.updated`: added nodes/edges glow green, removed fade red, changed
config pulses amber; diff persists briefly then settles to neutral.

### Failure state rule

**No dead ends.** Every failure state (`run.timeout`, `run.failed`, `validation.error`,
`provider.switched`, `retry`) must offer a next action (retry, resume, view details).

---

## API contract summary

- **REST** for commands and reads.
- **SSE** (`GET /api/runs/:runId/stream`) for the AI run stream. Not WebSockets —
  the interaction is unidirectional push; SSE runs over plain HTTP, auto-reconnects
  via `EventSource`, and `Last-Event-ID` gives free replay.
- **REST** for cancellation (`POST /api/runs/:runId/cancel`).

Every non-stream error uses `{ error: { code, message, details? } }` with a stable
machine code from `ErrorCode`.

Full endpoint list and SSE event catalogue: `Plans/04-api-contract.md`.

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

---

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

Never commit a `.env` file. Only `.env.example` files are tracked.

---

## CI (`.github/workflows/ci.yml`)

On push to `main`/`develop` and PRs to `main`:

1. Install deps (`pnpm install --frozen-lockfile`)
2. Build contract (`pnpm --filter @zoft/contract build`)
3. Typecheck all (`pnpm -r typecheck`)
4. Lint all (`pnpm -r lint`)
5. Test all (`pnpm test`)

All five must be green before merging. The contract build step is explicit because
both apps depend on its compiled output.

---

## Build phases

| Phase | What it adds | Status |
|-------|-------------|--------|
| 0 | Monorepo scaffold, contract package, Docker infra | ✅ Done |
| 1 | Prisma schema, node catalog seed, deterministic core + tests | Next |
| 2 | LLM provider abstraction, agent loop, RAG, self-correction | — |
| 3 | SSE streaming, BullMQ workers, cancellation, circuit breaker | — |
| 4 | Frontend chat core, SSE client, activity timeline | — |
| 5 | React Flow viz, diff highlight, version history, failure states | — |
| 6 | Production Dockerfiles, architecture docs, API docs, demo video | — |

Phase 1 starts from commit `d3e3fec`. It adds:
- `apps/backend/prisma/schema.prisma` (full domain schema above)
- `apps/backend/src/core/` (applier, validator, version applier)
- `apps/backend/src/core/__tests__/` (Vitest unit + property tests)
- Node catalog seed data

Phase 1 touches **nothing** in `packages/contract` or `apps/frontend`.

---

## Prototype stubs (no real spend required)

- **Stripe**: `POST /api/dev/simulate/stripe-payment` emits a fake payment event.
- **Slack / Teams**: outbound actions hit an internal mock sink that logs and returns
  success.
- **LLM**: `MockProvider` runs the full demo with zero API keys. Switch to real
  Anthropic with one env var.

`docker compose up` (Phase 6 full compose) must yield a working Copilot with
no external keys configured.

---

## Key files to know

| Path | What it is |
|------|-----------|
| `packages/contract/src/workflow.ts` | `WorkflowGraph`, `Operation` union, `ValidationResult` |
| `packages/contract/src/events.ts` | Full `SseEvent` discriminated union |
| `packages/contract/src/api.ts` | All REST DTOs and Zod body schemas |
| `apps/backend/src/core/` | Deterministic applier, validator, version applier (Phase 1+) |
| `apps/backend/prisma/schema.prisma` | Domain model (Phase 1+) |
| `infra/docker-compose.yml` | Postgres + Redis for local dev |
| `Plans/` | Full design documents for each phase (do not edit) |
| `PHASE0_DONE.md` | Decisions made and deviations from the handover spec |
