# Backend: AI Platform

The backend owns AI orchestration, workflow management, validation, persistence,
and execution. It exposes the contract in `04-api-contract.md` and nothing else.

Covered here: the domain model, the deterministic core (operations plus
validator), the agent orchestration, the async runtime, the reliability strategy,
and the backend build phases with acceptance criteria.

---

## 1. Domain model and persistence

Source of truth is Postgres. Workflow versions are immutable and append-only,
which gives us history, audit, and safe rollback for free.

### Core tables (Prisma)

- **workflow**: `id`, `name`, `ownerId`, `currentVersionId`, timestamps.
- **workflow_version**: `id`, `workflowId`, `version` (int, increments per
  workflow), `graph` (jsonb), `createdBy` (`user` or `ai`), `changeSummary`,
  `parentVersionId`, `createdAt`. Never updated after insert.
- **node_definition**: `type` (pk, e.g. `slack.send_message`), `category`
  (`trigger` or `action`), `displayName`, `description`, `provider`,
  `configSchema` (jsonb, a JSON Schema), `inputs` (jsonb), `outputs` (jsonb),
  `version`, `embedding` (vector). Data-driven: new rows add new nodes with no
  redeploy.
- **conversation**: `id`, `workflowId` (nullable until first workflow exists),
  `title`, timestamps.
- **message**: `id`, `conversationId`, `role` (`user` or `assistant`), `content`,
  `runId` (nullable), `createdAt`.
- **run**: `id`, `conversationId`, `status` (`pending`, `running`, `succeeded`,
  `failed`, `cancelled`, `timed_out`), `error` (jsonb, nullable), timestamps.
- **run_event**: `id`, `runId`, `seq` (monotonic per run), `type`, `payload`
  (jsonb), `createdAt`. This is the persisted trace. It backs both SSE replay and
  the frontend timeline.
- **job**: mirror of queue jobs for audit and idempotency keys.

### Workflow graph shape (stored in `workflow_version.graph`)

```jsonc
{
  "nodes": [
    {
      "id": "n1",
      "type": "stripe.payment_received",   // must exist in node_definition
      "config": {},                         // validated against that node's schema
      "position": { "x": 0, "y": 0 }        // viz only, ignored by validation
    },
    {
      "id": "n2",
      "type": "filter.condition",
      "config": { "field": "amount", "op": "gt", "value": 500 }
    },
    {
      "id": "n3",
      "type": "slack.send_message",
      "config": { "channel": "#payments", "text": "Payment received" }
    }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" },
    { "id": "e2", "source": "n2", "target": "n3" }
  ]
}
```

### Seed catalog for the prototype

Seed enough nodes to satisfy every scenario in the brief:
`stripe.payment_received` (trigger), `slack.send_message`, `teams.send_message`,
`filter.condition` (for "above $500"), `schedule.weekday_filter` (for "only on
weekdays"). Each carries a real JSON Schema for its config. This lets the demo
cover create, swap provider, add condition, and weekday rules.

---

## 2. The deterministic core (no AI here)

This is the safety layer. It is pure, synchronous, fully unit-tested, and has no
dependency on any LLM.

### Operations (the patch language the AI emits)

The AI never sends a full graph and never writes to the DB. It emits operations:

- `add_node { node }`
- `remove_node { nodeId }`
- `update_node_config { nodeId, config }`
- `replace_node { nodeId, newType, config }`  // e.g. Slack -> Teams
- `add_edge { edge }`
- `remove_edge { edgeId }`
- `set_node_config_field { nodeId, path, value }` // fine-grained edits

The **applier** takes `(currentGraph, operations[])` and returns a candidate
graph. It is deterministic and side-effect free.

### Validator (runs on the candidate graph before any write)

1. **Catalog check**: every node `type` exists in `node_definition`. Unknown type
   is the primary defence against hallucinated nodes.
2. **Config schema check**: each node `config` validates against its node's JSON
   Schema (Ajv). Collect all errors, do not stop at the first.
3. **Graph structural check**: exactly one trigger node with no inbound edges; no
   cycles (DAG); no dangling edges (source and target exist); no orphan action
   nodes disconnected from the trigger.
4. **Type compatibility check**: an edge is valid only if the source node's
   declared outputs are compatible with the target node's declared inputs.
5. **Trigger rules**: triggers cannot be edge targets; actions cannot be the root.

Output is `{ valid: true, graph }` or `{ valid: false, errors: ValidationError[] }`
where each error has a machine code, a human message, and the offending node or
edge id. These errors feed the AI self-correction loop and also render in the UI.

### Version applier (the only write path for graphs)

If validation passes, insert a new `workflow_version` with an incremented
`version`, set `createdBy`, write a `changeSummary`, link `parentVersionId`, and
update `workflow.currentVersionId`. Wrapped in a transaction. This function is the
**only** code in the system that writes workflow graphs.

Acceptance for the core: property tests confirm the applier plus validator never
persist an invalid graph, hallucinated types are always rejected, and every valid
operation set yields exactly one new version.

---

## 3. AI orchestration

### Provider abstraction

An `LlmProvider` interface with `stream(messages, tools, opts)` returning an async
iterable of deltas (text tokens and tool calls) plus a `finishReason`. Adapters:

- `MockProvider`: deterministic scripted responses. Default in dev and tests.
  Can be told to inject specific failures (bad JSON, unknown tool, unknown node,
  timeout) for the reliability tests.
- `AnthropicProvider`: real adapter, enabled by env var.
- Room for `GeminiProvider` later. Switching providers is one config change.

A `ProviderRouter` sits in front with a **circuit breaker** per provider and
failover order. Repeated failures open the breaker and route to the next provider
(or the mock), emitting a `provider.switched` run event.

### The agent loop

A bounded ReAct-style loop. Each turn: build a token-budgeted context, ask the
provider to stream, handle any tool calls, feed results back, repeat until the
model emits a final answer or a stop condition triggers.

Tools exposed to the model (all read-only or proposing, none write to the DB):

- `search_nodes(query)`: RAG over the node catalog (pgvector similarity plus a
  keyword fallback). Grounds the model in real, available nodes so it does not
  invent them.
- `get_node_schema(type)`: returns the config JSON Schema for a node type.
- `get_current_workflow()`: returns the current graph (compact form).
- `propose_operations(operations[])`: submits a patch. The orchestrator runs the
  validator. Errors are returned to the model for correction; they are not
  persisted.
- `commit()`: signals the proposed, validated operations should be applied. Only
  after a successful validation does the orchestrator call the version applier.

Context assembly per turn: the system prompt (role, rules, the "propose, never
mutate" contract), a summarised conversation history, the current workflow, and
only the node schemas retrieved this run. This keeps token use bounded even with
hundreds of nodes.

### Prompt architecture

- **System prompt**: fixed rules and the operation vocabulary. Versioned in
  `packages/contract` or a `prompts/` folder so prompt changes are reviewable
  (prompt versioning).
- **Tool schemas**: strict JSON Schemas so the provider returns structured calls.
- **Self-correction budget**: at most N (start with 3) validation-repair rounds
  per run. After N, the run fails cleanly with the accumulated errors surfaced to
  the user rather than looping forever.

### Explain and "why did you change that"

Explanations do not need operations. The orchestrator answers from the current
graph plus the version history: the `changeSummary` and diff between the last two
versions directly answer "what changed" and "why". This is why every version
stores an author and a summary.

Acceptance for orchestration: the scenario "create a workflow that sends a Slack
message whenever Stripe receives a payment" runs the full loop and persists one
valid version. "Replace Slack with Teams", "only notify above $500", and "only on
weekdays" each produce correct follow-up versions. "Explain this workflow" and
"why did you make that change" answer from stored state without new operations.

---

## 4. Async runtime and streaming

### Runs and SSE

A user message creates a `run` and returns its `runId` immediately (REST). The
client opens the SSE stream for that run. The orchestrator executes and emits
`run_event` rows; each is pushed to the SSE stream and persisted for replay. Event
types and shapes are defined in `04-api-contract.md`.

### Background workers (BullMQ)

Not everything belongs in the request path. Route to workers:

- **Embedding generation**: when a `node_definition` is created or updated, a job
  computes its embedding. This is how "new nodes without deployment" stays fast:
  insert the row, enqueue the embedding, and it becomes searchable shortly after.
- **Heavy validation or external lookups**: simulated latency for the demo, but
  the architecture is real. Worker progress publishes to Redis pub/sub, which the
  run's SSE stream relays as `agent.step` and `validation.progress` events.

Worker guarantees: retries with exponential backoff, a **dead-letter queue** for
exhausted jobs, and **idempotency keys** so a retried job never double-applies.

### Cancellation and timeouts

- Each run carries an `AbortController`. `POST /runs/:id/cancel` aborts it; the
  orchestrator stops the provider stream, marks the run `cancelled`, and emits
  `run.cancelled`.
- Each run has a wall-clock deadline. On expiry the run is marked `timed_out`, a
  `run.timeout` event is emitted, and any partial valid progress is preserved as a
  draft (never a silent partial commit).

---

## 5. Reliability strategy (failure mode to recovery)

| LLM failure | Detection | Recovery |
|-------------|-----------|----------|
| Hallucinates nodes | Catalog check in validator | Reject, return the unknown type to the model, self-correct. `search_nodes` grounds it first. |
| Invalid JSON | Tool-call parse fails | Bounded repair prompt; if still bad, fail the run with a clear message, no partial write. |
| Calls invalid tool | Tool not in registry | Reject the call, tell the model the allowed tools, retry within budget. |
| Exceeds context limit | Token budget guard before each call | Summarise history, retrieve only relevant schemas, send compact graph. |
| Incomplete answer | `finishReason` and validator (dangling edges, missing trigger) | Continuation turn or bounded retry; validator blocks partial graphs from persisting. |
| Times out | Per-run deadline plus provider timeout | Mark `timed_out`, preserve draft, allow resume or retry from the UI. |
| Provider unavailable | Errors trip the circuit breaker | Failover to next provider or mock, emit `provider.switched`, continue. |

Cross-cutting: every external call has a timeout, retries use backoff, jobs are
idempotent, exhausted jobs go to the DLQ, and every run is fully traced in
`run_event` so any failure is reconstructable after the fact.

---

## 6. Performance and scale posture

Design targets from the brief: 100k workflows, 10k conversations/day, workflows
with hundreds of nodes, multiple providers.

- **Read path**: current workflow served by `currentVersionId` (indexed).
  Conversation and version lists paginated.
- **Context bounding**: never load all nodes into a prompt; retrieve top-k via
  pgvector. This is what keeps hundreds-of-nodes workflows and a growing catalog
  affordable.
- **Write path**: append-only versions avoid update contention and give history
  cheaply.
- **Horizontal scale**: API instances are stateless; run state lives in Postgres
  and Redis, so SSE can be served by any instance and workers scale independently.
- **Cost tracking** (optional but cheap to add): record token usage per run on the
  `run` row for a simple cost dashboard.

---

## Backend build phases

### Phase 1: Domain and deterministic core
- Prisma schema and migrations; seed the node catalog.
- Operation types, applier, validator, version applier.
- Unit and property tests on the core.
- **Acceptance**: valid ops produce exactly one new version; invalid ops
  (bad config, hallucinated type, cycle, dangling edge) are always rejected with
  structured errors; the AI has no write path.

### Phase 2: AI orchestration
- `LlmProvider` interface, `MockProvider`, `AnthropicProvider`, `ProviderRouter`
  with circuit breaker.
- Agent loop, tool registry, RAG `search_nodes`, bounded self-correction.
- **Acceptance**: all six brief scenarios (create, swap, add threshold, weekday,
  explain, why) work end to end with the mock provider; failure-injection tests
  pass for each row in the reliability table.

### Phase 3: Runtime, streaming, workers
- Run lifecycle, SSE emission and persistence, `run_event` replay via `Last-Event-ID`.
- BullMQ workers for embeddings and heavy tasks; Redis pub/sub bridge to SSE.
- Cancellation, timeouts, DLQ, idempotency.
- **Acceptance**: streamed events match the contract exactly; cancel stops a run
  mid-flight; a forced provider outage triggers visible failover; a killed and
  reconnected stream replays missed events with no gaps.
