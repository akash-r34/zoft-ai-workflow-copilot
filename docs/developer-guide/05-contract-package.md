# 05 — The Contract Package

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

`packages/contract/` is the **only** place shared types live. Both `apps/backend` and
`apps/frontend` import from `@zoft/contract` — neither app ever redefines a shape that
belongs here. If you're about to write `interface WorkflowGraph` (or anything like it)
anywhere else, stop: it already exists in this package, or it should be added here first.

Why this matters in practice: the backend and frontend are two separate TypeScript
programs, compiled separately, that never see each other's source. Without a shared
package, "the backend's `WorkflowGraph`" and "the frontend's `WorkflowGraph`" would be two
structurally-similar-but-unrelated types that silently drift apart the moment someone edits
one and forgets the other. `@zoft/contract` makes that impossible: there is exactly one
`WorkflowGraph`, and both apps' `tsconfig` reference the same compiled output.

The whole package is 5 files, 238 lines total. Read all five — there's no shortcut, and
knowing this package cold is what lets you read every other chapter without stopping to
look up a type.

## File map

| File | Lines | What's in it |
|---|---|---|
| `src/workflow.ts` | 56 | The graph/node/edge shapes, the `Operation` union, `ValidationResult`, `CatalogEntry` |
| `src/events.ts` | 40 | `WorkflowDiff`, the `SseEvent` discriminated union, `AgentStepKind` |
| `src/api.ts` | 110 | REST request/response DTOs, Zod body schemas |
| `src/errors.ts` | 28 | `ErrorCode`, `ApiError`, the error envelope |
| `src/index.ts` | 4 | Barrel re-export — this is the only import path either app uses |

Both apps import as `import { Foo } from "@zoft/contract"` — never a deep path into
`src/`. That resolves through `src/index.ts:1-4`, which does `export * from "./workflow.js"`
etc. (Note the `.js` extension on a `.ts` file — that's the project's `NodeNext` module
resolution convention, not a typo; see `02-repo-map.md`.)

## `workflow.ts` — the graph itself

```ts
// packages/contract/src/workflow.ts:1-17
export interface WorkflowNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}
```

A `WorkflowGraph` is nothing more than an array of nodes and an array of edges. `type` on a
`WorkflowNode` is a string like `"stripe.payment_received"` or `"slack.send_message"` — it's
a foreign key into the node catalog (`04-data-model.md`'s `NodeDefinition` table), not an
enum baked into this package. That's deliberate: adding a new node type is a data change
(seed a new `NodeDefinition` row), never a contract change. `position` is purely for the
frontend's React Flow canvas (`10-frontend.md`) — the backend stores it but never reads it.

`EMPTY_GRAPH` (`workflow.ts:19`) is the zero value used when a brand-new `Workflow` is
created with no version yet.

### `Operation` — the only way a graph is ever changed

```ts
// packages/contract/src/workflow.ts:21-37
export type OperationKind =
  | "add_node"
  | "remove_node"
  | "update_node_config"
  | "replace_node"
  | "add_edge"
  | "remove_edge"
  | "set_node_config_field";

export type Operation =
  | { op: "add_node";              node: WorkflowNode }
  | { op: "remove_node";           nodeId: string }
  | { op: "update_node_config";    nodeId: string; config: Record<string, unknown> }
  | { op: "replace_node";          nodeId: string; newType: string; config: Record<string, unknown> }
  | { op: "add_edge";              edge: WorkflowEdge }
  | { op: "remove_edge";           edgeId: string }
  | { op: "set_node_config_field"; nodeId: string; path: string; value: unknown };
```

This is the single most important type in the whole system — it's the concrete form of
"the AI proposes operations" from the core invariant (`03-the-core-invariant.md`). The LLM
never emits a full `WorkflowGraph`; it emits an array of these seven tagged-union variants,
and `apps/backend/src/core/applier.ts` is the only code that turns `Operation[]` into a new
`WorkflowGraph`. Notice there is no `"replace_graph"` variant — that's on purpose, it would
be exactly the "AI writes the DB directly" failure mode the invariant exists to prevent.

### `ValidationResult` and `CatalogEntry`

```ts
// packages/contract/src/workflow.ts:39-56
export interface ValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export type ValidationResult =
  | { valid: true;  graph: WorkflowGraph }
  | { valid: false; errors: ValidationError[] };

export interface CatalogEntry {
  type: string;
  category: "trigger" | "action";
  configSchema: Record<string, unknown>;
  inputs:  Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
}
```

`ValidationResult` is a discriminated union on `valid` — TypeScript narrows `.graph` vs
`.errors` for you based on the `valid` check, which is why `core/validator.ts` (see
`06-deterministic-core.md`) never needs a null-check dance. `CatalogEntry` is the shape the
agent's `search_nodes`/`get_node_schema` tools return — it mirrors (but is distinct from)
the Prisma `NodeDefinition` model and the API's `NodeDefinitionDto`; see `04-data-model.md`
for why there are three similar-looking shapes and what each is for.

## `events.ts` — the SSE event union

```ts
// packages/contract/src/events.ts:10-29
interface BaseEvent { seq: number }

export type SseEvent =
  | (BaseEvent & { event: "run.started";          data: { runId: string } })
  | (BaseEvent & { event: "agent.step";           data: { kind: AgentStepKind; label: string } })
  | (BaseEvent & { event: "token";                data: { text: string } })
  | (BaseEvent & { event: "tool.call";            data: { tool: string; input: unknown; callId: string } })
  | (BaseEvent & { event: "tool.result";          data: { callId: string; ok: boolean; result?: unknown; error?: string } })
  | (BaseEvent & { event: "validation.progress";  data: { stage: string; pct: number } })
  | (BaseEvent & { event: "validation.error";     data: { errors: ValidationError[] } })
  | (BaseEvent & { event: "workflow.proposed";     data: { workflowId: string; version: number; graph: WorkflowGraph; diff: WorkflowDiff; summary: string } })
  | (BaseEvent & { event: "workflow.updated";      data: { workflowId: string; version: number; graph: WorkflowGraph; diff: WorkflowDiff } })
  | (BaseEvent & { event: "retry";                data: { attempt: number; max: number; reason: string } })
  | (BaseEvent & { event: "provider.switched";    data: { from: string; to: string; reason: string } })
  | (BaseEvent & { event: "run.completed";        data: { runId: string } })
  | (BaseEvent & { event: "run.failed";           data: { runId: string; error: ApiError } })
  | (BaseEvent & { event: "run.timeout";          data: { runId: string; draftAvailable: boolean } })
  | (BaseEvent & { event: "run.cancelled";        data: { runId: string } })
  | (BaseEvent & { event: "heartbeat";            data: Record<string, never> });
```

Every event that ever flows over the run's SSE stream is one of these 15 variants. `seq` is
a per-run monotonic integer (`08-api-and-runs.md` covers how it's assigned via
`redis/seq.ts`) — it's how both the server-side replay logic and the frontend's
`run-store.ts` (`10-frontend.md`) dedupe events after a reconnect. There is no
`"catch-all"` or `"unknown"` event: if you add a new kind of thing the backend needs to
tell the frontend, you add a variant here first (see `15-extending.md`'s "add an SSE event"
recipe) — the frontend's `switch`/reducer over `event` (`lib/step-map.ts`) will then fail to
compile until you handle it, which is the point.

`workflow.proposed` (line 21) is the approval-gate event — PRD v1.1 Decision #1. It carries
the full candidate graph plus a computed `diff` and a human-readable `summary`, but the run
does not resolve until an approve/reject call arrives; see `03-the-core-invariant.md`.

`AgentStepKind` (`events.ts:31-37`) is the small enum that drives the frontend's activity
timeline icons (`10-frontend.md`, `step-visuals.ts`): `planning`, `searching_nodes`,
`reading_schema`, `validating`, `proposing`, `repair`.

`WorkflowDiff` (`events.ts:4-8`) is a plain added/removed/changed structure, computed
server-side by `apps/backend/src/dto/diff.ts` and attached to both `workflow.proposed` and
`workflow.updated` — the frontend never diffs graphs itself, it only renders the diff it's
handed.

## `api.ts` — REST DTOs and request-body validation

This file has two jobs: **DTOs** (plain interfaces describing what a REST endpoint returns)
and **Zod schemas** (runtime validation for what a client sends in a request body). The
convention throughout: a `FooBodySchema` (Zod) plus its inferred `FooBody` type sit next to
each other, e.g.

```ts
// packages/contract/src/api.ts:31-34
export const CreateRunBodySchema = z.object({
  content: z.string().min(1),
});
export type CreateRunBody = z.infer<typeof CreateRunBodySchema>;
```

The backend route handler (`apps/backend/src/routes/runs.ts`) calls
`CreateRunBodySchema.parse(request.body)` — so the same schema is both the compile-time
type *and* the runtime guard against a malformed request, with no chance of the two
drifting apart (there's only one schema, not a hand-written interface plus a hand-written
validator that could disagree).

Sections, by comment banner in the file:
- **Pagination** (`api.ts:5`) — `CursorSchema`, used by any list endpoint.
- **Conversations** (`api.ts:8-28`) — `CreateConversationBodySchema`, `ConversationDto`,
  `MessageDto`.
- **Runs** (`api.ts:31-47`) — `CreateRunBodySchema`/`CreateRunBody`,
  `CreateRunResponseDto` (`{ runId, messageId }` — what `POST /conversations/:id/runs`
  returns immediately, well before the run finishes), and `RunStatus`.
- **Workflows** (`api.ts:50-76`) — `WorkflowVersionSummaryDto`, `WorkflowDto`,
  `WorkflowDiffDto`.
- **Node catalog** (`api.ts:79-88`) — `NodeDefinitionDto`, the shape
  `GET /node-definitions` returns.
- **Dev stubs** (`api.ts:91-95`) — `SimulateStripePaymentBodySchema`, backing the
  `POST /dev/simulate/stripe-payment` acknowledgement-only endpoint (`REMAINING.md` notes
  this doesn't yet trigger a real run — see `15-extending.md`).
- **Approval gate** (`api.ts:97-110`) — `ApproveRunResponseDto` (`{ status: "approved",
  version }`) and `RejectRunResponseDto` (`{ status: "rejected" }`), the two possible
  results of resolving a paused, proposed run.

## `errors.ts` — one error shape for the whole API

```ts
// packages/contract/src/errors.ts:3-28
export const ErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "NODE_NOT_FOUND",
  "WORKFLOW_NOT_FOUND",
  "RUN_NOT_FOUND",
  "CONVERSATION_NOT_FOUND",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code:    ErrorCodeSchema,
  message: z.string(),
  details: z.array(z.unknown()).optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: ApiErrorSchema,
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
```

Every REST error response body is `{ error: { code, message, details? } }` — no endpoint
ever throws a bespoke shape. `apps/backend/src/routes/errors.ts` is the one place that
turns an internal exception into this envelope (see `08-api-and-runs.md`); the frontend's
`lib/api.ts` has exactly one place that parses it back out. If you add a new failure mode
that a client needs to distinguish, add a new `ErrorCode` variant here — don't invent a new
top-level response shape.

## Why this package has no logic

Every file here is types and Zod schemas — there isn't a single function that *does*
anything beyond `.parse()`. That's intentional: this package compiles to both a Node.js
backend and a Next.js frontend bundle, so anything with a runtime dependency (Prisma,
Fastify, React) would either bloat the frontend bundle or fail to compile for it. If you're
tempted to add a helper function here, ask whether it can live in one app's own `lib/`
instead — it almost always can.

---
**Prev:** [`04-data-model.md`](./04-data-model.md) · **Next:**
[`06-deterministic-core.md`](./06-deterministic-core.md) · **Related:**
[`03-the-core-invariant.md`](./03-the-core-invariant.md),
[`08-api-and-runs.md`](./08-api-and-runs.md)
