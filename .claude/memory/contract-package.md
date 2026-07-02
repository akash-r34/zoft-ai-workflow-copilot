# `packages/contract` — detail

Referenced from the root `CLAUDE.md`. The enforced seam between backend and frontend —
see the root file for the governing rule ("never define a shared type outside
`packages/contract`").

## Files

- **`workflow.ts`** — `WorkflowNode`, `WorkflowEdge`, `WorkflowGraph`, `EMPTY_GRAPH`
  (the only runtime value here — everything else is a pure type), `OperationKind`,
  `Operation` union (`add_node`, `remove_node`, `update_node_config`, `replace_node`,
  `add_edge`, `remove_edge`, `set_node_config_field`), `ValidationError`,
  `ValidationResult`, `CatalogEntry`. This is what `apps/backend/src/core/types.ts`
  re-exports rather than redefining.
- **`events.ts`** — `SseEvent` discriminated union (keyed on `event`), every variant
  carries a monotonic `seq`: `run.started`, `agent.step`, `token`, `tool.call`,
  `tool.result`, `validation.progress`, `validation.error`, `workflow.updated`
  (carries `WorkflowDiff`), `retry`, `provider.switched`, `run.completed`,
  `run.failed`, `run.timeout`, `run.cancelled`, `heartbeat`. Also `AgentStepKind` and
  `WorkflowDiff`.
- **`errors.ts`** — Zod-backed: `ErrorCodeSchema` (enum: `VALIDATION_FAILED`,
  `NODE_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `RUN_NOT_FOUND`, `CONVERSATION_NOT_FOUND`,
  `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `INTERNAL`), `ApiErrorSchema`,
  `ErrorEnvelopeSchema`, plus their inferred TS types.
- **`api.ts`** — REST request/response DTOs and Zod body schemas: conversations
  (`CreateConversationBodySchema`, `ConversationDto`, `MessageDto`), runs
  (`CreateRunBodySchema`, `CreateRunResponseDto`, `RunStatus`), workflows
  (`WorkflowVersionSummaryDto`, `WorkflowDto`, `WorkflowDiffDto`), node catalog
  (`NodeDefinitionDto` — richer than `CatalogEntry`: adds `displayName`, `description`,
  `provider`), dev stubs (`SimulateStripePaymentBodySchema`).
- **`index.ts`** — `export * from` all four files with `.js` specifiers (NodeNext ESM).
  Every exported symbol is available directly from `@zoft/contract`.

## Build

`package.json`: `name: "@zoft/contract"`, ESM (`type: "module"`), `main`/`types` point
at `dist/`. `pnpm --filter @zoft/contract build` must run before typecheck/lint/test on
either app — both `apps/backend` and `apps/frontend` import the compiled output.

**Add a field to the contract before writing code that depends on it.** The contract is
the source of truth, not the app code.
