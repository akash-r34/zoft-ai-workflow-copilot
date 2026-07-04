# 03 — The Core Invariant

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

If you only read one chapter of this guide before writing code, read this one. Every other
architectural decision in the backend — the shape of `Operation`, why there's a `Run.
proposedOps` column, why there's a `commit.ts` that's barely 20 lines, why the approval UI
exists — is a direct consequence of one rule.

## The rule

> **The AI proposes operations. Deterministic code validates and applies them.
> The AI never writes to the database directly.**

Unpack that into four concrete steps:

1. The agent reasons and calls **read-only** tools — `search_nodes`, `get_node_schema`,
   `get_current_workflow` (`07-agent-and-providers.md`). None of these can change anything.
2. It emits a typed **operation patch** by calling `propose_operations` — never a full graph,
   never raw SQL. The patch is an `Operation[]` (`05-contract-package.md`'s
   `workflow.ts:30-37`) — a small, closed set of edits like "add this node" or "set this
   config field," not "here is the new graph, save it."
3. A **deterministic validator with no LLM involved**,
   `apps/backend/src/core/validator.ts`'s `validateGraph` (`validator.ts:38`), checks catalog
   membership, JSON-Schema config validity, DAG structure, and edge type compatibility. It
   is a plain synchronous function — same input, same output, every time, forever.
4. Per PRD v1.1 Decision #1, a **human approval step** sits between validation and the
   write. Only when a human calls `POST /api/runs/:runId/approve` does
   `apps/backend/src/core/version-applier.ts`'s `applyVersion` (`version-applier.ts:67`)
   write exactly **one** new immutable `workflow_version` row.

## Why this exists

An LLM is non-deterministic and can hallucinate. If the agent could write to the database
directly — even "just update this JSON column" — a bad tool call or a persuasive prompt
injection could silently corrupt a user's live automation. By funneling every possible
AI-driven change through the same narrow gate (`Operation[]` → validate → human approval →
one writer), you get, for free:

- **Safety** — nothing reaches the database that hasn't passed the same battery of checks a
  human-initiated change would also have to pass.
- **A full audit trail** — every accepted change is a new `WorkflowVersion` row with
  `createdBy`, `changeSummary`, and `parentVersionId` (`04-data-model.md`); nothing is ever
  overwritten.
- **A well-defined recovery surface** — every LLM failure mode (bad tool call, invalid
  config, an ambiguous request) has exactly one place it's caught: the validator's error
  list, surfaced as a `validation.error` SSE event and, if the self-correction budget allows,
  retried (`07-agent-and-providers.md`).

## Follow the exact code path

Here is every hop, in order, with the file and line where it happens. Keep this open next
to the source the first time you read it.

### 1 — The agent proposes (never writes)

`apps/backend/src/agent/orchestrator.ts`'s `handleDelta` (`orchestrator.ts:235-299`) is the
only place a tool call's result is interpreted. When the tool is `propose_operations` and it
succeeded:

```ts
// apps/backend/src/agent/orchestrator.ts:279-291
if (delta.tool === "propose_operations" && result.ok) {
  const proposeOutcome = result.result as ProposeOutcome;
  if (proposeOutcome.valid) {
    const input = delta.input as { ops: Operation[]; summary?: string };
    return {
      kind: "proposed",
      ops: input.ops,
      graph: proposeOutcome.graph,
      summary: input.summary ?? "Workflow updated.",
    };
  }
  return { kind: "validation_failed", errors: proposeOutcome.errors };
}
```

Notice what's returned: `ops` (the raw `Operation[]` the agent asked for) and
`proposeOutcome.graph` — the **already-validated** candidate graph. `propose_operations`
(the tool, `tools/propose-operations.ts`) calls `applyOperations` +`validateGraph`
internally purely to check the proposal is legal — it does not write anything. Nothing has
touched Postgres yet.

### 2 — The orchestrator pauses instead of committing

```ts
// apps/backend/src/agent/orchestrator.ts:301-359 (handleProposal, abridged)
async function handleProposal(...): Promise<void> {
  const diff = diffGraphs(before, proposal.graph);
  // ... (APPROVAL_REQUIRED=false legacy/test path omitted — see file)

  await prisma.run.update({
    where: { id: runId },
    data: {
      proposedOps: proposal.ops as unknown as Prisma.InputJsonValue,
      proposedGraph: proposal.graph as unknown as Prisma.InputJsonValue,
      proposalSummary: proposal.summary,
      proposalStatus: "pending",
    },
  });

  await appendEvent(runId, {
    event: "workflow.proposed",
    data: { workflowId, version: previewVersion, graph: proposal.graph, diff, summary: proposal.summary },
  });
  // The run stays "running" — heartbeats keep the stream alive until
  // POST /api/runs/:runId/approve or /reject resolves it.
}
```

This is the load-bearing moment: the candidate `ops` and `graph` are stashed on the `Run`
row itself (`Run.proposedOps`/`proposedGraph`, `04-data-model.md`), a `workflow.proposed`
SSE event goes out, and the function **returns** — no `workflow_version` row exists yet.
The run's `status` is still `"running"` in the database; it will not move to `"succeeded"`
or `"failed"` until a human resolves the proposal. (There's a legacy `APPROVAL_REQUIRED=false`
branch right above this in the same function, still present for tests — see
`14-ops-and-docker.md`'s env reference — but the default and the production path is always
the pause.)

### 3 — A human approves or rejects

Only `apps/backend/src/routes/runs.ts` can move a pending proposal forward, and only two
routes touch it:

```ts
// apps/backend/src/routes/runs.ts:41-67 (approve, abridged)
app.post("/api/runs/:runId/approve", async (request): Promise<ApproveRunResponseDto> => {
  const run = await prisma.run.findUnique({ where: { id: runId }, include: { conversation: true } });
  if (run.proposalStatus !== "pending") {
    throw new ApiErrorException("VALIDATION_FAILED", `run ${runId} has no pending proposal to approve`, 400);
  }
  // ...
  const catalog = toCatalogEntries(await loadCatalog(prisma));
  const ops = run.proposedOps as unknown as Operation[];
  const summary = run.proposalSummary ?? "Applied AI-proposed change";
  const result = await commitProposal(prisma, workflowId, ops, catalog, summary);
  // result.error -> emit validation.error + run.failed, HTTP 409, NOTHING written
  // result.version/.graph -> emit workflow.updated + run.completed
});
```

Two things worth internalizing:
- **`ops` is replayed, not `graph`.** The approve handler pulls `run.proposedOps` (the
  operations) and calls `commitProposal`, which re-runs `applyOperations` +
  `validateGraph` against whatever the workflow's *current* graph is **right now** — not
  the graph that was current when the proposal was first made. If another change landed in
  between, re-validation can legitimately fail here (`runs.ts:69-91`), and the response is
  HTTP 409 with zero writes. This is defense-in-depth, not paranoia: the gap between
  "validated" and "approved" can be arbitrarily long (a human might not click Approve for
  minutes), and the invariant has to hold even then.
- **`reject`** (`routes/runs.ts:108-136`) never calls `commitProposal` at all — it just
  flips `proposalStatus` to `"rejected"`, posts a "Change discarded" assistant message, and
  ends the run. There is no path from reject to a database write.

### 4 — `commitProposal` — the one function the approve route may call

```ts
// apps/backend/src/tools/commit.ts (full file, 20 lines)
export function commitProposal(
  prisma: PrismaClient,
  workflowId: string,
  ops: Operation[],
  catalog: CatalogEntry[],
  changeSummary: string,
): Promise<{ version: number; graph: WorkflowGraph } | { error: ValidationError[] }> {
  return applyVersion(prisma, workflowId, ops, catalog, "ai", changeSummary);
}
```

`commit.ts` is deliberately almost content-free — its entire job is to be *the one
grep-able name* between "a route handler decided to write" and "the actual write happens."
Its own file comment says it plainly: **"Called exclusively from routes/runs.ts's POST
/approve handler... Never called by agent/orchestrator.ts directly."** If you ever find a
second caller of `commitProposal`, or a second caller of `applyVersion` that isn't
`commitProposal` or `restoreVersion` (`06-deterministic-core.md`), the invariant has been
broken — treat that as a bug, not a refactor to preserve.

### 5 — `applyVersion` — the only writer

`apps/backend/src/core/version-applier.ts:67` is where the actual `INSERT` happens — see
`06-deterministic-core.md` for the full walkthrough of `applyOperations`, `validateGraph`,
and `applyVersion` together. The one-sentence summary: it re-derives the candidate graph
from the current graph plus `ops`, re-validates it, and only on a clean pass does it, in a
single Postgres transaction, insert one `WorkflowVersion` row and repoint
`Workflow.currentVersionId` at it (`version-applier.ts:75-98`).

## The write-path map

Everything above, as one table — if you're ever unsure whether a piece of code is allowed
to reach the database, check it against this:

| Layer | File | Can write a `workflow_version`? |
|---|---|---|
| Agent tool loop | `agent/orchestrator.ts` | **No** — only stages `Run.proposed*` columns |
| Propose tool | `tools/propose-operations.ts` | **No** — validates a candidate, doesn't persist it |
| Approve route | `routes/runs.ts` (`POST .../approve`) | Calls the one function that can |
| Commit wrapper | `tools/commit.ts` | Thin pass-through to `applyVersion` |
| **The writer** | `core/version-applier.ts` (`applyVersion`, `restoreVersion`) | **Yes — the only two functions in the whole codebase that do** |
| Background workers | `workers/{embedding,validation,archival}-worker.ts` | **No** — see `09-workers.md` for exactly what each is scoped to instead |

## The three background workers, checked against this same rule

Phase 6 added three BullMQ workers (`09-workers.md`). Each was designed with this invariant
as an explicit constraint, not an afterthought:
- **Embedding worker** — writes only `NodeDefinition.embedding`. Never touches a workflow or
  version row.
- **Validation worker** — **read-only**. It re-validates every workflow's current graph
  against the live catalog and reports problems via `Job.lastError`. It never calls
  `applyVersion` and never repairs anything automatically.
- **Archival worker** — writes only `WorkflowVersion.archivedAt`, a lifecycle timestamp.
  Never the content columns (`graph`/`version`/`changeSummary`/`parentVersionId`), and never
  through `version-applier.ts` — it's a direct, narrow `UPDATE` for exactly one column.

## What to check before adding any new write path

If you're implementing a new feature and find yourself about to write to `Workflow` or
`WorkflowVersion` from somewhere new, stop and ask:

1. Does this write originate from something the AI proposed? If yes, it must go through
   `applyVersion`, reachable only after a human approval, exactly like today.
2. Is this a lifecycle annotation (like `archivedAt`), not graph content? Those are allowed
   to bypass `version-applier.ts`, but must be narrowly scoped to one non-content column and
   documented as such (see the doc comments on `WorkflowVersion.archivedAt` in
   `schema.prisma:76-81`, `04-data-model.md`).
3. Is this a genuinely new kind of user-initiated write (like "restore to version N")? Add a
   new function to `core/version-applier.ts` that still validates and still writes exactly
   one new version — see `restoreVersion` (`version-applier.ts:116`) for the template.

---
**Prev:** [`02-repo-map.md`](./02-repo-map.md) · **Next:**
[`04-data-model.md`](./04-data-model.md) · **Related:**
[`06-deterministic-core.md`](./06-deterministic-core.md),
[`07-agent-and-providers.md`](./07-agent-and-providers.md),
[`12-end-to-end-trace.md`](./12-end-to-end-trace.md)
