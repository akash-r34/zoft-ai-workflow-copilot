# Phase 1 — Done

Domain model (Prisma schema + migration + seed) and the deterministic core
(applier, validator, version applier) are implemented and tested. All
acceptance criteria pass. No AI, no HTTP routes, no queues — that's Phase 2/3.

## Decisions made that weren't fully prescribed by the handover doc

**Types live in `@zoft/contract`, not `core/types.ts`.** Exploration found that
`packages/contract/src/workflow.ts` already exports every shape the handover
asks `core/types.ts` to define — `WorkflowNode`, `WorkflowEdge`, `WorkflowGraph`,
`EMPTY_GRAPH`, `Operation`, `ValidationError`, `ValidationResult`,
`CatalogEntry` — verbatim. CLAUDE.md's rule ("never define a shared type
outside `packages/contract`") is absolute, so `core/types.ts` re-exports from
`@zoft/contract` instead of redeclaring. `packages/contract` and
`apps/frontend` were not touched this phase.

**Empty graph is valid.** A 0-node candidate graph short-circuits past the
trigger-count check (`{ valid: true }`). Every workflow starts from
`EMPTY_GRAPH`; an in-progress candidate with no nodes yet must be
representable, not rejected for lacking a trigger. Dangling-edge and
cycle-detection checks still run unconditionally (harmless on a genuinely
empty graph, but not skipped just because node count is 0).

**`update_node_config` replaces the config object wholesale**, not a deep
merge. `set_node_config_field` is the tool for a single nested-path edit. This
is documented in the function's JSDoc and exercised in
`applier.test.ts`.

**`remove_node` does not cascade-delete connected edges.** The applier does
exactly what each operation says and nothing more; a caller that removes a
node is expected to also remove its edges (or the validator will report
`DANGLING_EDGE`). This keeps the applier's behavior predictable and pushes
graph-invariant enforcement to the validator, matching the "AI proposes,
deterministic code validates" split.

**Vector column deferred to Phase 3** (explicit choice, confirmed with the
user before implementation). `node_definition` has no `embedding` column in
this migration; adding `vector(1536)` later is a non-breaking additive
migration once the embedding worker exists, and avoids coupling the very
first migration to the pgvector extension inside Prisma's shadow database.

**`applyVersion` is typed with the real generated `PrismaClient`** (matches
the handover's literal signature). Rather than inventing a hand-rolled
structural interface to make it "fake-able" (which risks silently drifting
from Prisma's actual generic method signatures), the unit test
(`version-applier.test.ts`) builds a small in-memory fake and passes it via
one clearly-commented `as unknown as PrismaClient` cast at the test boundary.
That cast is pinned safe by the test itself: `version-applier.ts` never calls
any `PrismaClient` method beyond `workflow.findUnique/update`,
`workflowVersion.aggregate/create`, and `$transaction` — exactly what the fake
implements. A guarded real-database integration test
(`version-applier.integration.test.ts`) additionally proves the fake stays
faithful to real Prisma's behavior.

**Integration test gates on a dedicated `RUN_DB_INTEGRATION_TESTS` flag, not
on `DATABASE_URL`.** Discovered during verification: importing
`@prisma/client` auto-loads `apps/backend/.env` as a side effect, so
`DATABASE_URL` is already populated for any developer who has done the normal
onboarding step of copying `.env.example` to `.env` — regardless of whether
Postgres is actually running. Gating the suite on `DATABASE_URL` alone would
have made `pnpm test` silently attempt a live DB connection (and fail/hang)
for anyone with a plain `.env` and no Docker running. The dedicated opt-in
flag keeps the suite skipped by default everywhere (CI included, which has
neither variable) and only runs on an explicit, deliberate request:
```
docker compose -f infra/docker-compose.yml up -d
RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @zoft/backend test -- version-applier.integration
```

**`workflow` ↔ `workflow_version` uses two named Prisma relations**
(`WorkflowVersions` for the one-to-many back-reference, `CurrentVersion` for
the optional one-to-one current-version pointer) to express the cyclic FK
Prisma requires both sides of a relation to be declared. Verified against the
live schema with `\d workflow` / `\d workflow_version` — `currentVersionId`
carries `ON DELETE SET NULL`, `workflow_version.workflowId` carries
`ON DELETE RESTRICT`.

**`message.runId` stays a plain scalar `String?`**, no FK — matches the
handover exactly (a run may not exist yet when the message row is first
written).

**Ajv is imported as `import { Ajv } from "ajv"`** (named import), not the
default-export form the Ajv README shows. Under this repo's
`"module"/"moduleResolution": "NodeNext"` + `esModuleInterop: true`, the
default-import form resolved to the CJS module namespace object instead of
the class (`TS2351: This expression is not constructable`), cascading into
several "possibly undefined" errors. Ajv v8's `.d.ts` exports the same class
as both `export default Ajv` and a named `export declare class Ajv`, so the
named import is a clean, zero-risk fix — verified with a full `tsc --noEmit`
pass. `esModuleInterop: true` was also added to `apps/backend/tsconfig.json`
(package-local override, same pattern the frontend already uses per
`next build`'s auto-additions) since it's needed regardless for other CJS
interop.

**No lodash.** `set_node_config_field` uses a ~15-line inline dot-path setter.
Core's only non-Prisma external dependency is Ajv.

**`pnpm-workspace.yaml`'s `allowBuilds`/`onlyBuiltDependencies`** were
extended to approve `prisma`, `@prisma/client`, and `@prisma/engines` postinstall
scripts (pnpm 11 blocks these by default; same pattern PHASE0 used for
`esbuild`).

## Verification performed

- `prisma migrate status` → one applied migration (`20260702141854_init`).
- `prisma db seed` → all five node definitions present, confirmed via direct
  `psql` query (`stripe.payment_received`, `slack.send_message`,
  `teams.send_message`, `filter.condition`, `schedule.weekday_filter`).
- `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` all exit 0 (contract,
  backend, frontend).
- Import-boundary grep confirms no file outside `apps/backend/src/core/`
  references `version-applier`.
- Integration suite verified in both states: skips cleanly by default
  (`pnpm --filter @zoft/backend test` → 23 passed | 2 skipped), and passes
  against live Docker Postgres when explicitly opted in
  (`RUN_DB_INTEGRATION_TESTS=1 … test` → 25 passed).

## `pnpm --filter @zoft/backend exec vitest run --reporter=verbose` output

```
 RUN  v1.6.1 /Users/akashr/Zoft AI - Assignment/apps/backend

 ✓ src/__tests__/placeholder.test.ts > scaffold > is alive
 ✓ src/core/__tests__/applier.test.ts > applyOperations > adds a node to an empty graph
 ✓ src/core/__tests__/applier.test.ts > applyOperations > treats remove_node on a missing id as a no-op, without throwing
 ✓ src/core/__tests__/applier.test.ts > applyOperations > replace_node changes type and config but preserves id and position
 ✓ src/core/__tests__/applier.test.ts > applyOperations > update_node_config replaces the config object wholesale (documented behavior)
 ✓ src/core/__tests__/applier.test.ts > applyOperations > set_node_config_field sets a nested field via dot-notation path
 ✓ src/core/__tests__/applier.test.ts > applyOperations > returns a graph equal to the input when applying an empty operation list
 ✓ src/core/__tests__/applier.test.ts > applyOperations > does not mutate the input graph
 ✓ src/core/__tests__/version-applier.test.ts > applyVersion > starts from EMPTY_GRAPH and creates version 1 when currentVersionId is null
 ✓ src/core/__tests__/version-applier.test.ts > applyVersion > increments the version number from the existing max version for the workflow
 ✓ src/core/__tests__/version-applier.test.ts > applyVersion > writes nothing and returns validation errors when the candidate graph is invalid
 ✓ src/core/__tests__/version-applier.test.ts > applyVersion > throws when the workflow does not exist
 ✓ src/core/__tests__/applier.property.test.ts > applyOperations (property) > never throws, and the resulting node-id sequence matches a reference simulation, for any sequence of add_node/remove_node ops
 ✓ src/core/__tests__/validator.test.ts > validateGraph > passes for a valid trigger + action graph connected by one edge
 ✓ src/core/__tests__/validator.test.ts > validateGraph > passes for an empty graph (documented: no nodes means no trigger-count violation)
 ✓ src/core/__tests__/validator.test.ts > validateGraph > reports UNKNOWN_NODE_TYPE for a node whose type is not in the catalog
 ✓ src/core/__tests__/validator.test.ts > validateGraph > reports INVALID_CONFIG when a node's config fails its JSON Schema
 ✓ src/core/__tests__/validator.test.ts > validateGraph > reports TRIGGER_COUNT for a graph with two trigger nodes
 ✓ src/core/__tests__/validator.test.ts > validateGraph > reports CYCLE_DETECTED for a graph containing a cycle
 ✓ src/core/__tests__/validator.test.ts > validateGraph > reports DANGLING_EDGE when an edge references a nonexistent node
 ✓ src/core/__tests__/validator.test.ts > validateGraph > reports ORPHAN_NODE for an action node unreachable from the trigger
 ✓ src/core/__tests__/validator.test.ts > validateGraph > reports TRIGGER_HAS_INBOUND when a trigger node is an edge target
 ✓ src/core/__tests__/validator.test.ts > validateGraph > collects multiple errors from a single call instead of short-circuiting

 Test Files  5 passed | 1 skipped (6)
      Tests  23 passed | 2 skipped (25)
   Duration  186ms (transform 91ms, setup 0ms, collect 242ms, tests 73ms, environment 1ms, prepare 259ms)
```

(The 2 skipped tests are `version-applier.integration.test.ts`, gated behind
`RUN_DB_INTEGRATION_TESTS`; see above for how to run them. They pass — 25/25
— when that flag is set against the Docker Postgres.)

## Open questions for Phase 2

1. **Service layer signature for `applyVersion`'s `catalog` argument.**
   Phase 2's agent tools (`propose_operations`, `commit`) will need a service
   wrapper that loads `CatalogEntry[]` from the `node_definition` table before
   calling `applyVersion` — that read path (and its shape: does it cache the
   catalog per-request, per-process, or re-query every call?) isn't decided
   yet.
2. **Formal import-boundary enforcement.** The "nothing outside `core/`
   imports `version-applier`" rule is currently verified by a manual grep
   (documented above). Once Phase 2 adds a route/service layer, consider a
   real ESLint rule (`no-restricted-imports` with a `zones`/`patterns` config)
   so this is enforced in CI rather than by convention.
3. **`applyVersion`'s "workflow not found" behavior is a thrown `Error`,
   not a typed result.** The handover doesn't specify this case. Phase 2's
   HTTP layer will need to catch it and map it to `WORKFLOW_NOT_FOUND` from
   `@zoft/contract`'s `ErrorCode` enum — flagging so that mapping doesn't get
   missed.
4. **`node_definition.embedding` (pgvector) column** is intentionally absent
   this phase (see decisions above) — Phase 3 needs to add it as a fresh
   additive migration alongside the embedding worker, not retrofit it into
   the `init` migration.
