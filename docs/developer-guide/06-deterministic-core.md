# 06 — The Deterministic Core

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

`apps/backend/src/core/` is 4 files, ~554 lines, and it's the safety heart of the whole
application — read `03-the-core-invariant.md` first if you haven't, since this chapter is
"how," and that one is "why." Every function in `core/` (except `version-applier.ts`'s two
entry points, which do talk to Postgres) is **pure**: no I/O, no `Date.now()`, no
randomness, same input always produces the same output. That's not a style preference —
it's what makes the validator trustworthy and the applier's tests exhaustive
(`13-testing.md` covers `applier.property.test.ts`, a property-based test that throws
thousands of random operation sequences at `applyOperations` and checks invariants hold).

```
core/
  types.ts            re-exports @zoft/contract's domain types — see below
  applier.ts   (117)   applyOperations — turns Operation[] into a new WorkflowGraph
  validator.ts (265)   validateGraph — checks a graph against the catalog + structural rules
  version-applier.ts (150)  applyVersion / restoreVersion — the only two DB writers
  index.ts     (4)     barrel re-export
```

## `core/types.ts` — deliberately empty of its own types

```ts
// apps/backend/src/core/types.ts (full file, 22 lines)
export type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowGraph,
  Operation,
  ValidationError,
  ValidationResult,
  CatalogEntry,
} from "@zoft/contract";

export { EMPTY_GRAPH } from "@zoft/contract";
```

Notice this file defines nothing new — it's a local re-export of `@zoft/contract`'s types
(`05-contract-package.md`), so the rest of `core/` can `import from "./types.js"` without
every file reaching into the workspace package directly, and so a future contract change
surfaces here first. If you ever need a "core-only" type that shouldn't be shared with the
frontend, it still doesn't belong here — put it in a new local file instead of extending
`types.ts`, to keep this file's single job intact.

## `applier.ts` — turning an `Operation[]` into a new graph

```ts
// apps/backend/src/core/applier.ts:26-34
export function applyOperations(graph: WorkflowGraph, ops: Operation[]): WorkflowGraph {
  let next: WorkflowGraph = structuredClone(graph);

  for (const op of ops) {
    next = applyOne(next, op);
  }

  return next;
}
```

Three contract points, straight from the function's own doc comment
(`applier.ts:7-20`), that matter more than the implementation:

1. **Never mutates.** `structuredClone(graph)` up front (`applier.ts:27`) means the caller's
   original graph object is untouched — you can safely call this speculatively (which is
   exactly what `propose_operations` does) without risking corrupting the "before" graph
   you're diffing against.
2. **Never throws.** An operation referencing a missing node/edge id is silently skipped
   (see `remove_node`'s guard at `applier.ts:41-44`, or `withNode`'s guard at
   `applier.ts:89-91`) — structural correctness is the *validator's* job, not the applier's.
   This division matters: the applier answers "what would the graph look like," the
   validator answers "is that graph legal."
3. **`update_node_config` replaces, it doesn't merge.** If you want to change one nested
   field without clobbering the rest of a node's config, that's what
   `set_node_config_field` (`applier.ts:67-72`, using the `setPath` helper at
   `applier.ts:99-117`) is for — it walks a dot-notation path and creates intermediate
   objects as needed.

### The exhaustiveness guard

```ts
// apps/backend/src/core/applier.ts:74-80
default: {
  // Exhaustiveness guard: if the contract's Operation union grows a new
  // variant without this switch being updated, TS fails the build here.
  const exhaustive: never = op;
  return exhaustive;
}
```

This is a pattern worth recognizing everywhere in this codebase (`validator.ts`'s
`checkStructure` doesn't need one since it doesn't switch over `Operation`, but anywhere
that does switches over a contract union should have one). If someone adds an eighth
`Operation` variant to `packages/contract` (`05-contract-package.md`) and forgets to handle
it in `applyOne`, this line makes the TypeScript build fail at that `default` case — not a
silent runtime no-op. See `15-extending.md`'s recipe for adding an operation kind; this is
the first place the compiler will stop you if a step is missed.

## `validator.ts` — five checks, one pass, every error collected

```ts
// apps/backend/src/core/validator.ts:38-49
export function validateGraph(graph: WorkflowGraph, catalog: CatalogEntry[]): ValidationResult {
  const errors: ValidationError[] = [];
  const catalogByType = new Map(catalog.map((entry) => [entry.type, entry]));

  checkCatalogMembership(graph, catalogByType, errors);
  checkConfigSchemas(graph, catalogByType, errors);
  checkStructure(graph, catalogByType, errors);
  checkTypeCompatibility(graph, catalogByType, errors);
  checkTriggerRules(graph, catalogByType, errors);

  return errors.length === 0 ? { valid: true, graph } : { valid: false, errors };
}
```

The key design choice: **it never short-circuits.** All five checks always run and push
into the same `errors` array, so a graph with three unrelated problems gets all three
reported in one pass — instead of a user fixing one error, resubmitting, and discovering the
next one. This is also why the self-correction loop
(`07-agent-and-providers.md`'s `orchestrator.ts`) can hand the LLM a complete error list to
fix in one repair attempt rather than iterating error-by-error.

| # | Function | Line | Error code(s) | What it catches |
|---|---|---|---|---|
| 1 | `checkCatalogMembership` | `validator.ts:53` | `UNKNOWN_NODE_TYPE` | A node's `type` isn't in the catalog |
| 2 | `checkConfigSchemas` | `validator.ts:71` | `INVALID_CONFIG` | A node's `config` fails its catalog entry's JSON Schema (via `ajv`) |
| 3 | `checkStructure` | `validator.ts:108` | `DANGLING_EDGE`, `CYCLE_DETECTED`, `TRIGGER_COUNT`, `ORPHAN_NODE` | Graph shape rules — see below |
| 4 | `checkTypeCompatibility` | `validator.ts:213` | `TYPE_MISMATCH` | An edge connects an output type to an incompatible input type |
| 5 | `checkTriggerRules` | `validator.ts:249` | `TRIGGER_HAS_INBOUND` | Something points an edge *into* a trigger node |

### Check 3 deserves a closer look — it's four sub-checks in one function

```ts
// apps/backend/src/core/validator.ts:108-157 (checkStructure, abridged)
function checkStructure(graph, catalog, errors): void {
  // 3c. Dangling edges — checked unconditionally.
  // ... DANGLING_EDGE for any edge whose source/target isn't a real node id

  // 3b. Cycles — checked unconditionally.
  if (hasCycle(graph)) errors.push({ code: "CYCLE_DETECTED", ... });

  // Empty graph: nothing left to check — see module doc for rationale.
  if (graph.nodes.length === 0) return;

  // 3a. Exactly one trigger.
  const triggers = graph.nodes.filter((n) => catalog.get(n.type)?.category === "trigger");
  if (triggers.length !== 1) {
    errors.push({ code: "TRIGGER_COUNT", ... });
    return; // "reachable from the trigger" is undefined without exactly one
  }

  // 3d. Every non-trigger node reachable from the trigger.
  // ... ORPHAN_NODE for anything hasCycle's reachableFrom() can't reach
}
```

Two things worth calling out:
- **An empty graph (`nodes: []`) is valid** (`validator.ts:130-132`). Every new `Workflow`
  starts at `EMPTY_GRAPH` (`05-contract-package.md`), and an in-progress candidate with zero
  nodes has to be representable — rejecting it for "no trigger" would make it impossible to
  ever start building a workflow from nothing.
- **`TRIGGER_COUNT` short-circuits the reachability check** (`validator.ts:141`, an early
  `return`) — "reachable from the trigger" is meaningless if there isn't exactly one
  trigger, so the function doesn't try. Dangling-edge and cycle checks run unconditionally
  regardless, since those don't depend on there being a well-defined trigger.

Cycle detection (`hasCycle`, `validator.ts:169-190`) and reachability
(`reachableFrom`, `validator.ts:192-209`) both build an adjacency list once
(`buildAdjacency`, `validator.ts:159-167`) and do a straightforward DFS/BFS — nothing exotic,
just worth knowing these three helpers exist if you ever need a fourth structural check.

### Check 4 — how "type compatible" is decided

```ts
// apps/backend/src/core/validator.ts:229-235
const outputTypes = sourceEntry.outputs.map((o) => o.type);
const inputTypes = targetEntry.inputs.map((i) => i.type);

const compatible =
  outputTypes.includes("any") ||
  inputTypes.includes("any") ||
  outputTypes.some((t) => inputTypes.includes(t));
```

Compatibility is a simple set-overlap check, with `"any"` acting as a wildcard on either
side. This is why `filter.condition`'s input/output types in the seed catalog
(`prisma/seed.ts:90-91`, `04-data-model.md`) are `"any"` — a filter node is meant to sit
between arbitrary node types without the validator complaining.

## `version-applier.ts` — the only two DB-writing functions

Everything above this line in the file is pure. `version-applier.ts` is where the core
crosses into I/O, and its own module doc comment says exactly why that's allowed here and
nowhere else:

```ts
// apps/backend/src/core/version-applier.ts:40-49 (applyVersion's doc comment)
/**
 * ...
 * This is the **only** function in the codebase that writes a workflow graph
 * to the database — every other write path is forbidden by convention...
 * Callers (a Phase 2 service layer, never route handlers directly) must go
 * through this function.
 */
```

### `applyVersion` — propose → validate → write, in one transaction

```ts
// apps/backend/src/core/version-applier.ts:67-99 (abridged)
export async function applyVersion(
  prisma, workflowId, ops, catalog, createdBy, changeSummary,
): Promise<{ version: number; graph: WorkflowGraph } | { error: ValidationError[] }> {
  return prisma.$transaction(async (tx) => {
    const workflow = await tx.workflow.findUnique({ where: { id: workflowId }, include: { currentVersion: true } });
    if (!workflow) throw new Error(`Workflow "${workflowId}" not found`);

    const currentGraph = workflow.currentVersion !== null
      ? (workflow.currentVersion.graph as unknown as WorkflowGraph)
      : EMPTY_GRAPH;

    const candidateGraph = applyOperations(currentGraph, ops);   // <- core/applier.ts
    const result = validateGraph(candidateGraph, catalog);       // <- core/validator.ts

    if (!result.valid) return { error: result.errors };

    return writeNewVersion(tx, workflowId, workflow.currentVersionId, candidateGraph, createdBy, changeSummary);
  });
}
```

This function is the whole invariant in ~30 lines: fetch the *current* graph, re-derive the
candidate by re-running `applyOperations` (not trusting a previously-computed graph, in case
time has passed since it was proposed), re-run `validateGraph`, and only write on a clean
pass. `prisma.$transaction(...)` wraps everything — on an invalid result, the transaction
still commits, but with **zero writes**, because the code path simply never calls
`writeNewVersion`.

### `writeNewVersion` — the actual insert, shared by both entry points

```ts
// apps/backend/src/core/version-applier.ts:7-38 (abridged)
async function writeNewVersion(tx, workflowId, currentVersionId, candidateGraph, createdBy, changeSummary) {
  const agg = await tx.workflowVersion.aggregate({ where: { workflowId }, _max: { version: true } });
  const nextVersion = (agg._max.version ?? 0) + 1;

  const created = await tx.workflowVersion.create({
    data: { workflowId, version: nextVersion, graph: candidateGraph, createdBy, changeSummary, parentVersionId: currentVersionId },
  });

  await tx.workflow.update({ where: { id: workflowId }, data: { currentVersionId: created.id } });

  return { version: nextVersion, graph: candidateGraph };
}
```

Two writes, same transaction: **insert** the new `WorkflowVersion` row (with
`parentVersionId` pointing at whatever was current before — this is what makes the version
history a traceable chain, not just a flat list), then **update** `Workflow.
currentVersionId` to point at it. This is the only place in the entire codebase either of
those two things happens.

### `restoreVersion` — the second (and last) legitimate writer

```ts
// apps/backend/src/core/version-applier.ts:116-150 (abridged)
export async function restoreVersion(prisma, workflowId, targetVersion, catalog) {
  return prisma.$transaction(async (tx) => {
    const workflow = await tx.workflow.findUnique({ where: { id: workflowId } });
    const target = await tx.workflowVersion.findUnique({ where: { workflowId_version: { workflowId, version: targetVersion } } });
    if (!target) throw new Error(`Version ${targetVersion} not found for workflow "${workflowId}"`);

    const targetGraph = target.graph as unknown as WorkflowGraph;
    const result = validateGraph(targetGraph, catalog);   // re-validated even though it was valid once
    if (!result.valid) return { error: result.errors };

    return writeNewVersion(tx, workflowId, workflow.currentVersionId, targetGraph, "user", `Restored to version ${targetVersion}`);
  });
}
```

"Restore to version N" is a **user** action (not an AI proposal — `createdBy: "user"` is
hardcoded), but it still goes through `writeNewVersion` — restoring doesn't overwrite
history, it appends a *new* version whose content happens to match an old one. Its own doc
comment (`version-applier.ts:101-110`) explains why it re-validates a graph that was already
valid once: "this is the same defense-in-depth the approval gate relies on at commit time" —
consistency of guarantees matters more than the (usually negligible) extra check.

## Why "pure" is worth defending

Because `applyOperations` and `validateGraph` have no side effects and no hidden state,
they're exhaustively testable: `applier.property.test.ts` (`13-testing.md`) can generate
thousands of random `Operation[]` sequences and assert general properties ("removing a node
that was just added always returns to the original graph," etc.) instead of hand-writing
one test per case. If you ever add I/O to either function — a database read, a call to an
external service — you lose that testing leverage, and you also break the "validator runs
identically at propose-time and at commit-time" guarantee the approval gate depends on
(`03-the-core-invariant.md`). Keep new checks in `validator.ts` pure; if a check genuinely
needs I/O (e.g. calling out to a live external API to verify a Slack channel exists), that
belongs in a tool or a worker, not here.

---
**Prev:** [`05-contract-package.md`](./05-contract-package.md) · **Next:**
[`07-agent-and-providers.md`](./07-agent-and-providers.md) · **Related:**
[`03-the-core-invariant.md`](./03-the-core-invariant.md),
[`13-testing.md`](./13-testing.md)
