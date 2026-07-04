# 04 — The Data Model

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

Everything the backend persists lives in one file: `apps/backend/prisma/schema.prisma`
(208 lines, 8 models, 4 enums). Prisma reads this file and generates a fully-typed database
client (`@prisma/client`) — every `prisma.workflow.findUnique(...)` call elsewhere in the
backend is typed from what you're about to read here.

This chapter is model-by-model. Read it once fully before touching `core/` or `agent/` —
almost everything else in the backend is "read one of these models, maybe write one of
these models, following the rules below."

## The shape of the schema file

```
schema.prisma:1-15    generator/datasource boilerplate
schema.prisma:17-42    4 enums (NodeCategory, MessageRole, RunStatus, JobStatus)
schema.prisma:44-57    model Workflow
schema.prisma:59-85    model WorkflowVersion
schema.prisma:87-112   model NodeDefinition
schema.prisma:114-126  model Conversation
schema.prisma:128-141  model Message
schema.prisma:143-175  model Run
schema.prisma:177-191  model RunEvent
schema.prisma:193-208  model Job
```

## `Workflow` — the root, mutable-pointer entity

```prisma
// apps/backend/prisma/schema.prisma:44-57
model Workflow {
  id                String            @id @default(cuid())
  name              String
  ownerId           String
  currentVersionId  String?           @unique
  currentVersion    WorkflowVersion?  @relation("CurrentVersion", fields: [currentVersionId], references: [id])
  versions          WorkflowVersion[] @relation("WorkflowVersions")
  conversations     Conversation[]
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  @@map("workflow")
}
```

A `Workflow` row itself is almost content-free — a name, an owner, and a pointer
(`currentVersionId`) at the one `WorkflowVersion` that's "live" right now. `ownerId` is
hardcoded to a fixed `"dev-user"` string everywhere it's set (there's no auth layer yet —
see `REMAINING.md`). The only field that ever changes on an existing `Workflow` row is
`currentVersionId`, and the only code allowed to change it is
`apps/backend/src/core/version-applier.ts` (`06-deterministic-core.md`).

## `WorkflowVersion` — immutable, append-only history

```prisma
// apps/backend/prisma/schema.prisma:59-85
/// Immutable, append-only. Never update a row — only insert.
/// Exception: `archivedAt` (below) — a lifecycle annotation, never the
/// content columns (graph/version/createdBy/changeSummary/parentVersionId),
/// and never written through core/version-applier.ts. See
/// workers/archival-worker.ts.
model WorkflowVersion {
  id              String    @id @default(cuid())
  workflowId      String
  workflow        Workflow  @relation("WorkflowVersions", fields: [workflowId], references: [id])
  version         Int
  graph           Json
  createdBy       String
  changeSummary   String
  parentVersionId String?
  createdAt       DateTime  @default(now())
  currentOf       Workflow? @relation("CurrentVersion")

  archivedAt      DateTime?

  @@unique([workflowId, version])
  @@map("workflow_version")
}
```

This is where the "full version history" half of the core invariant lives. Every accepted
change creates a **new row** — `graph` (the entire `WorkflowGraph` as JSON), a monotonic
per-workflow `version` integer, `createdBy` (`"user"` or `"ai"`), a human-readable
`changeSummary`, and `parentVersionId` linking back to the version it was built from. Rows
are never updated once inserted, with one carefully-scoped exception: `archivedAt`
(added by migration `20260704122900_add_version_archived_at`), which
`workers/archival-worker.ts` (`09-workers.md`) sets on versions older than
`ARCHIVE_AFTER_DAYS` (default 90) — per PRD v1.1 Decision #3 ("retain everything, never
delete"). It's a lifecycle timestamp, not content — nothing reads it to filter version
history today (see `REMAINING.md` for the deliberately-deferred `?includeArchived=` filter).

The `@@unique([workflowId, version])` constraint is what makes "version 7 of workflow X" a
well-defined, collision-proof identity.

## `NodeDefinition` — the data-driven node catalog

```prisma
// apps/backend/prisma/schema.prisma:87-112
/// Data-driven node catalog. `type` is the primary key (e.g. "slack.send_message").
/// Adding a new node type is a row insert, not a redeploy.
model NodeDefinition {
  type         String       @id
  category     NodeCategory
  displayName  String
  description  String
  provider     String
  configSchema Json
  inputs       Json
  outputs      Json
  nodeVersion  Int          @default(1)

  embedding    Unsupported("vector(256)")?

  @@map("node_definition")
}
```

`type` (e.g. `"stripe.payment_received"`, `"slack.send_message"`) is the primary key and the
same string referenced by `WorkflowNode.type` in the contract package
(`05-contract-package.md`). `configSchema` is a JSON Schema document — this is what
`core/validator.ts` runs `ajv` against to check a node's `config` is well-formed
(`06-deterministic-core.md`). See `prisma/seed.ts:20-113` for the 5 seeded rows
(`stripe.payment_received`, `slack.send_message`, `teams.send_message`,
`filter.condition`, `schedule.weekday_filter`) — that seed function
(`prisma/seed.ts:115-123`) is an idempotent `upsert` keyed on `type`, so re-running it is
always safe, including inside the Docker entrypoint (`14-ops-and-docker.md`).

`embedding` is a raw `vector(256)` column Prisma can't natively type (hence
`Unsupported(...)` — Prisma tracks the column exists without trying to generate a typed
accessor for it). It's populated by `workers/embedding-worker.ts`, read by
`catalog/vector-search.ts`, and never touched anywhere else. See `07-agent-and-providers.md`
for the RAG story this enables.

## `Conversation` and `Message` — the chat layer

```prisma
// apps/backend/prisma/schema.prisma:114-141
model Conversation {
  id         String    @id @default(cuid())
  workflowId String?
  workflow   Workflow? @relation(fields: [workflowId], references: [id])
  title      String    @default("New conversation")
  messages   Message[]
  runs       Run[]
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  @@map("conversation")
}

model Message {
  id             String       @id @default(cuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id])
  role           MessageRole
  content        String
  runId          String?
  createdAt      DateTime     @default(now())

  @@map("message")
}
```

A `Conversation` starts with no `workflowId` — that gets set the first time a run inside it
produces an approved workflow. `title` defaults to `"New conversation"` and is
auto-updated from the first user message (a truncation, not an LLM call — see
`routes/conversations.ts`, `08-api-and-runs.md`). `Message.runId` is a plain scalar with no
foreign-key constraint on purpose: an assistant `Message` row is created before its `Run`
necessarily exists (or in some flows, updated after), so a strict FK would create an
ordering dependency the code doesn't actually need.

## `Run` — one AI turn's full lifecycle, including the approval gate

```prisma
// apps/backend/prisma/schema.prisma:143-175
model Run {
  id             String       @id @default(cuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id])
  status         RunStatus
  error          Json?
  tokenUsage     Int?
  events         RunEvent[]
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  cancelRequested Boolean @default(false)

  proposedOps     Json?
  proposedGraph   Json?
  proposalSummary String?
  proposalStatus  String?

  @@map("run")
}
```

This is the busiest model in the schema, added-to by migration
`20260704064747_add_run_proposal` (`prisma/migrations/20260704064747_add_run_proposal/
migration.sql:1-6`) on top of the original `init` migration. `status` is one of the 6
`RunStatus` enum values (`schema.prisma:27-34`: `pending`, `running`, `succeeded`, `failed`,
`cancelled`, `timed_out`) — the same union re-exported from `packages/contract` as
`RunStatus`.

The four `proposed*`/`cancelRequested` fields are what make the PRD v1.1 human-approval
gate possible:
- **`cancelRequested`** — set by `POST /runs/:id/cancel`; the orchestrator's per-step loop
  (`agent/orchestrator.ts`, `07-agent-and-providers.md`) polls this and bails out cleanly
  instead of continuing.
- **`proposedOps`** — the `Operation[]` array the agent emitted, stored **before** it's ever
  applied. This is what `tools/commit.ts` replays through the real `applyVersion` at
  approval time — re-validated against whatever the workflow's *current* version is by
  then, not just trusted from when the proposal was first made.
- **`proposedGraph`** — the resulting candidate graph, stored for display parity with the
  `workflow.proposed` SSE payload (`05-contract-package.md`) so the frontend doesn't need a
  separate fetch to show what's pending.
- **`proposalSummary`** — the human-readable change description shown in the approval UI.
- **`proposalStatus`** — `null` (no proposal was ever made — e.g. a pure explain/why turn),
  `"pending"`, `"approved"`, or `"rejected"`.

Read `03-the-core-invariant.md` for exactly which code paths read and write these four
fields — that's the chapter that ties this model to the safety guarantee.

## `RunEvent` — the persisted SSE trace

```prisma
// apps/backend/prisma/schema.prisma:177-191
/// Persisted SSE trace. `seq` is monotonic per run — enforced in application
/// code, not the database. Backs replay (Last-Event-ID) and the frontend
/// activity timeline.
model RunEvent {
  id        String   @id @default(cuid())
  runId     String
  run       Run      @relation(fields: [runId], references: [id])
  seq       Int
  type      String
  payload   Json
  createdAt DateTime @default(now())

  @@index([runId, seq])
  @@map("run_event")
}
```

Every `SseEvent` (`05-contract-package.md`) that's ever sent to a client is first persisted
here — Postgres is the single source of truth for replay (a client that reconnects with a
`Last-Event-ID` header gets everything after that `seq` from this table, not from memory).
`seq` monotonicity is enforced by application code (`redis/seq.ts`'s atomic counter), not a
database sequence or constraint — see `08-api-and-runs.md` for exactly how and why.

## `Job` — background-worker bookkeeping

```prisma
// apps/backend/prisma/schema.prisma:193-208
/// Background job bookkeeping for BullMQ workers (embedding generation, heavy
/// validation, external lookups). Idempotency key guards against duplicate
/// enqueues; retries/backoff live in the worker, not this row.
model Job {
  id             String    @id @default(cuid())
  idempotencyKey String    @unique
  type           String
  status         JobStatus
  payload        Json
  attempts       Int       @default(0)
  lastError      String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@map("job")
}
```

One `Job` table backs all three BullMQ workers (embedding, validation, archival —
`09-workers.md`). `idempotencyKey` doubles as the BullMQ `jobId` itself, so re-enqueuing the
same logical unit of work is a no-op at both layers. `status` is the 5-value `JobStatus`
enum (`schema.prisma:36-42`: `pending`, `processing`, `done`, `failed`, `dead_lettered`) —
`dead_lettered` means the job exhausted its retry attempts and a human needs to look at
`lastError`.

## Migrations — how the schema got here

```
prisma/migrations/
  20260702141854_init/                        the original 8-model schema (minus embedding/archivedAt)
  20260704064747_add_run_proposal/             adds cancelRequested + the 4 proposal columns to Run
  20260704121807_add_node_embedding/           adds NodeDefinition.embedding vector(256)
  20260704122900_add_version_archived_at/      adds WorkflowVersion.archivedAt
```

The last two are hand-written SQL rather than `prisma migrate dev` output — Prisma's shadow
database (used to validate a migration by replaying it) doesn't have the `vector` extension
enabled, so the normal dev flow fails at diff time for anything touching a `vector` column.
The fix used throughout this repo: write the `.sql` file by hand, then apply it with
`prisma migrate deploy` (which applies migrations directly without touching the shadow DB).
See `14-ops-and-docker.md` for the exact commands if you need to add a fifth migration.

---
**Prev:** [`03-the-core-invariant.md`](./03-the-core-invariant.md) · **Next:**
[`05-contract-package.md`](./05-contract-package.md) · **Related:**
[`09-workers.md`](./09-workers.md), [`14-ops-and-docker.md`](./14-ops-and-docker.md)
