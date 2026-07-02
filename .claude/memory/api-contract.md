# API contract — detail

Referenced from the root `CLAUDE.md`. No HTTP routes exist yet (Phase 3+) — this is the
design target.

- **REST** for commands and reads.
- **SSE** (`GET /api/runs/:runId/stream`) for the AI run stream. Not WebSockets — the
  interaction is unidirectional push; SSE runs over plain HTTP, auto-reconnects via
  `EventSource`, and `Last-Event-ID` gives free replay (see
  `.claude/memory/backend-architecture.md` for the replay mechanism).
- **REST** for cancellation (`POST /api/runs/:runId/cancel`).

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

The `diff` shape is computed by Phase 2/3 at query time; `workflow_version.graph`
(JSONB, full graph per version) already stores everything needed to compute it.
