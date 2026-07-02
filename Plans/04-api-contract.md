# Shared API Contract

This is the seam between the two teams. Both sides depend on the types in
`packages/contract`; neither redefines them. A team should be able to build either
side from this document alone.

## Transport decisions

- **Commands and reads: REST/JSON.** Simple, cacheable, easy to document and test.
- **AI run output: Server-Sent Events.** Justification below.
- **Cancellation: REST.** A control action, not part of the stream.

### Why SSE over WebSockets

The AI interaction is one request followed by a stream of server-to-client
updates (steps, tokens, workflow diffs, completion). That is a unidirectional
push, which is exactly what SSE is for. SSE runs over ordinary HTTP/1.1 and
HTTP/2 with no upgrade handshake, passes through proxies cleanly, and the browser
`EventSource` API gives automatic reconnection plus event replay via the
`Last-Event-ID` header for free. WebSockets add a persistent bidirectional
channel we do not need, along with their own reconnection, heartbeat, and
back-pressure handling that we would have to build ourselves. The only client to
server signal we need mid-run is cancellation, and a one-shot REST call models
that more honestly than a socket message. If a future feature needed true
bidirectional low-latency exchange (collaborative editing, for instance), a
WebSocket channel could be added alongside without disturbing this contract.

## Error model (every non-stream error)

```jsonc
{
  "error": {
    "code": "VALIDATION_FAILED",   // stable machine code
    "message": "Human readable summary",
    "details": []                   // optional, e.g. per-node validation errors
  }
}
```

Codes include: `VALIDATION_FAILED`, `NODE_NOT_FOUND`, `WORKFLOW_NOT_FOUND`,
`RUN_NOT_FOUND`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `INTERNAL`.

## REST endpoints

### Conversations and messages
- `POST /api/conversations` -> `{ id }`. Creates a conversation.
- `GET /api/conversations` -> list (paginated).
- `GET /api/conversations/:id/messages?cursor=` -> message page.

### Runs (send a message, start AI work)
- `POST /api/conversations/:id/runs`
  body: `{ "content": "send a Slack message when Stripe gets a payment" }`
  -> `{ "runId": "...", "messageId": "..." }`. Returns immediately; work streams.
- `GET /api/runs/:runId/stream` -> SSE stream (see below).
- `POST /api/runs/:runId/cancel` -> `{ "status": "cancelled" }`.

### Workflows and versions
- `GET /api/workflows/:id` -> `{ id, name, currentVersion: { version, graph } }`.
- `GET /api/workflows/:id/versions?cursor=` -> version list with
  `{ version, createdBy, changeSummary, createdAt }`.
- `GET /api/workflows/:id/versions/:v` -> full graph for that version.
- `GET /api/workflows/:id/diff?from=&to=` -> structured diff (added / removed /
  changed nodes and edges) for the diff view.
- `POST /api/workflows/:id/versions/:v/restore` -> creates a new version equal to
  version `v`; returns the new version. Restore is itself an auditable change.

### Node catalog
- `GET /api/node-definitions?query=&cursor=` -> catalog, searchable. Backs any
  frontend node picker and documents what the AI can use.

### Dev-only stubs (prototype)
- `POST /api/dev/simulate/stripe-payment` body `{ "amount": 750 }` -> emits a
  simulated payment event so trigger behaviour is demonstrable without real Stripe.

## SSE stream format

Standard SSE framing. Each event carries an `id` (the run-scoped `seq`, used for
`Last-Event-ID` replay), an `event` name, and a JSON `data` payload.

```
id: 12
event: agent.step
data: {"seq":12,"kind":"searching_nodes","label":"Searching available nodes"}
```

### Event catalogue

| event | payload (data) | meaning |
|-------|----------------|---------|
| `run.started` | `{ seq, runId }` | Run began. |
| `agent.step` | `{ seq, kind, label }` | A reasoning or work step (`planning`, `searching_nodes`, `reading_schema`, `validating`, `proposing`, `repair`). |
| `token` | `{ seq, text }` | A chunk of streamed assistant prose. |
| `tool.call` | `{ seq, tool, input, callId }` | The AI invoked a tool. |
| `tool.result` | `{ seq, callId, ok, result?, error? }` | Result of that tool call. |
| `validation.progress` | `{ seq, stage, pct }` | Deterministic validation running. |
| `validation.error` | `{ seq, errors:[{code,message,nodeId?}] }` | Validation found problems (may precede a repair). |
| `workflow.updated` | `{ seq, workflowId, version, graph, diff }` | A new version was persisted; `diff` drives highlighting. |
| `retry` | `{ seq, attempt, max, reason }` | A bounded retry is happening. |
| `provider.switched` | `{ seq, from, to, reason }` | Circuit breaker failed over. |
| `run.completed` | `{ seq, runId }` | Run finished successfully. |
| `run.failed` | `{ seq, runId, error }` | Run failed after recovery attempts; no partial write. |
| `run.timeout` | `{ seq, runId, draftAvailable }` | Deadline hit; optional draft preserved. |
| `run.cancelled` | `{ seq, runId }` | User cancelled. |
| `heartbeat` | `{ seq }` | Keep-alive and liveness signal. |

### Ordering and replay guarantees

- `seq` is monotonic per run. The client renders as a pure function of the ordered
  event list.
- On reconnect the client sends `Last-Event-ID: <last seq>`; the backend replays
  persisted `run_event` rows with a higher `seq`, then resumes live. Exactly-once
  rendering, no gaps.

## The contract package

`packages/contract` exports: request and response DTOs, zod schemas for every
body, the discriminated-union type for SSE events, and the error model. Both apps
import from it. Any change here is a deliberate, reviewable change to the boundary
itself, which is exactly the separation the brief asks us to demonstrate.
