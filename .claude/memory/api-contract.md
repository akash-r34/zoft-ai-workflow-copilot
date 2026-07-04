# API contract — detail

Referenced from the root `CLAUDE.md`. The real backend (`apps/backend`) now
implements this contract in full (Phase 2–3 core — see
`.claude/memory/build-phases.md`), byte-compatible with the frontend's mock backend
(`apps/frontend/mock/server.ts`, dev-only, kept as an independent peer) — see
`.claude/memory/frontend-architecture.md` and `PHASE4_5_DONE.md`.

- **REST** for commands and reads.
- **SSE** (`GET /api/runs/:runId/stream`) for the AI run stream. Not WebSockets — the
  interaction is unidirectional push; SSE runs over plain HTTP, auto-reconnects via
  `EventSource`, and `Last-Event-ID` gives free replay (see
  `.claude/memory/backend-architecture.md` for the replay mechanism).
- **REST** for cancellation (`POST /api/runs/:runId/cancel`) and, per PRD v1.1
  Decision #1, the approval gate: `POST /api/runs/:runId/approve` and
  `POST /api/runs/:runId/reject`. A validated candidate change pauses the run
  (`workflow.proposed` SSE event, run stays `running`) until one of these resolves
  it — see `.claude/memory/backend-architecture.md`'s approval gate section.

Every non-stream error uses `{ error: { code, message, details? } }` with a stable
machine code from `@zoft/contract`'s `ErrorCode` enum (see
`.claude/memory/contract-package.md`).

Full endpoint list and SSE event catalogue: `Plans/04-api-contract.md`.

Key response shapes the backend schema must support (defined fully in
`packages/contract/src/api.ts`):

```typescript
// GET /api/workflows/:id
{ id: string; name: string; currentVersion: { version: number; graph: WorkflowGraph } | null }

// GET /api/workflows/:id/versions (paginated)
{ version: number; createdBy: "user" | "ai"; changeSummary: string; createdAt: string }

// GET /api/workflows/:id/diff
{
  from: number; to: number;
  added:   { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  removed: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  changed: Array<{ id: string; before: WorkflowNode; after: WorkflowNode }>;
}
```

The `diff` shape is computed at query time by `apps/backend/src/dto/diff.ts`'s
`diffGraphs`/`toWorkflowDiffDto` (ported from `apps/frontend/mock/graph-ops.ts`);
`workflow_version.graph` (JSONB, full graph per version) stores everything needed.

The SSE event union also includes `workflow.proposed` — carries `{ workflowId,
version, graph, diff, summary }`, identical shape to `workflow.updated` plus
`summary`, emitted when a candidate change validates but awaits human approval
(see above). Not in the frontend's `TERMINAL_EVENTS` set — the stream stays open.
