# API reference

Base URL: `http://localhost:3001` (the backend's `PORT`, default 3001). All request/
response bodies are JSON except the stream endpoint, which is
`text/event-stream`. Every error response uses the same envelope:

```json
{ "error": { "code": "WORKFLOW_NOT_FOUND", "message": "...", "details": ["..."] } }
```

`code` is one of `packages/contract/src/errors.ts`'s `ErrorCode` enum:
`VALIDATION_FAILED`, `NODE_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `RUN_NOT_FOUND`,
`CONVERSATION_NOT_FOUND`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `INTERNAL`.

## Conversations

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/conversations` | `{ title?: string }` | `ConversationDto` |
| GET | `/api/conversations` | — | `ConversationDto[]` |
| GET | `/api/conversations/:id/messages` | — | `MessageDto[]` |

A conversation's `title` starts as `"New conversation"` and is automatically
renamed from its first message (a cheap truncation, no LLM call) the first time a
run starts on it — see `apps/backend/src/runs/run-service.ts`'s
`deriveTitleFromMessage`. It only ever renames once.

## Runs — the AI turn lifecycle

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/conversations/:id/runs` | `{ content: string }` | `{ runId, messageId }` |
| GET | `/api/runs/:runId/stream` | — | SSE stream (see below) |
| POST | `/api/runs/:runId/cancel` | — | `{ status: "cancelled" }` |
| POST | `/api/runs/:runId/approve` | — | `{ status: "approved", version }` |
| POST | `/api/runs/:runId/reject` | — | `{ status: "rejected" }` |

Starting a run returns immediately; the orchestrator runs fire-and-forget and
streams its progress over SSE. `approve`/`reject` only succeed while the run has a
pending proposal (`400 VALIDATION_FAILED` otherwise — including on a second call to
either, once resolved).

### `GET /api/runs/:runId/stream`

Standard SSE framing (`id: <seq>\ndata: <json>\n\n`). Send the `Last-Event-ID`
header to resume after a disconnect — every event already persisted with a higher
`seq` replays first, then live events follow with no gap or duplicate. A `heartbeat`
event (`seq: 0`, filtered by name on the client) arrives every 15s to detect a
silently-dead connection.

Every event is one of (`packages/contract/src/events.ts`'s `SseEvent` union), each
carrying a monotonic `seq`:

| Event | Data | Terminal? |
|---|---|---|
| `run.started` | `{ runId }` | no |
| `agent.step` | `{ kind, label }` — kind is `planning\|searching_nodes\|reading_schema\|validating\|proposing\|repair` | no |
| `token` | `{ text }` — streamed prose | no |
| `tool.call` | `{ tool, input, callId }` | no |
| `tool.result` | `{ callId, ok, result? , error? }` | no |
| `validation.progress` | `{ stage, pct }` | no |
| `validation.error` | `{ errors: ValidationError[] }` | no |
| `workflow.proposed` | `{ workflowId, version, graph, diff, summary }` — validated, awaiting `approve`/`reject`; the run stays `running` | **no** |
| `workflow.updated` | `{ workflowId, version, graph, diff }` — fires after `approve` | no |
| `retry` | `{ attempt, max, reason }` | no |
| `provider.switched` | `{ from, to, reason }` | no |
| `run.completed` | `{ runId }` | yes |
| `run.failed` | `{ runId, error }` | yes |
| `run.timeout` | `{ runId, draftAvailable }` | yes |
| `run.cancelled` | `{ runId }` | yes |
| `heartbeat` | `{}` | no |

## Workflows and versions

| Method | Path | Query/Body | Returns |
|---|---|---|---|
| GET | `/api/workflows/:id` | — | `WorkflowDto` (`{ id, name, currentVersion }`) |
| GET | `/api/workflows/:id/versions` | — | `WorkflowVersionSummaryDto[]`, newest first |
| GET | `/api/workflows/:id/versions/:v` | — | full version detail (incl. `graph`) |
| GET | `/api/workflows/:id/diff` | `?from=N&to=M` | `WorkflowDiffDto` |
| POST | `/api/workflows/:id/versions/:v/restore` | — | full version detail for the new (restored) version |

`restore` re-saves an existing version's graph verbatim as a **new** version — it
still goes through the same deterministic writer (`core/version-applier.ts`) and
re-validates first, so it can fail with `409 VALIDATION_FAILED` if the target graph
no longer validates against the current catalog.

Versions older than `ARCHIVE_AFTER_DAYS` (default 90) get an internal
`archivedAt` timestamp (see `docs/architecture.md`) but are never filtered out of
these endpoints or exposed in any DTO.

## Node catalog

| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/api/node-definitions` | `?query=` | `NodeDefinitionDto[]` |

Same catalog the agent's `search_nodes` tool uses: a pgvector semantic search first
(once the embedding worker has backfilled a row), falling back to a keyword match
over type/displayName/provider/description.

## Dev stub

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/dev/simulate/stripe-payment` | `{ amount, currency }` | `{ received: true, amount, currency }` |

Acknowledges receipt only — nothing currently triggers a run from it (no
webhook-driven execution; see `REMAINING.md`).

## Health

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ ok: true }` |
