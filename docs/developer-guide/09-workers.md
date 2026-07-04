# 09 — Background Workers

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

Everything so far runs inside the API process (`apps/backend/src/index.ts`). This chapter
covers the **second process**: `pnpm --filter @zoft/backend worker` (or the `worker`
service in `infra/docker-compose.yml`, `14-ops-and-docker.md`), which runs three BullMQ
workers against the same Postgres and Redis. Read `03-the-core-invariant.md` before this
chapter — every worker here was designed against that invariant as an explicit constraint,
and this chapter checks each one against it.

```
queues/
  queue-names.ts (23)   QUEUE name constants + the 3 payload interfaces
  job-store.ts   (58)   All Job-table writes, in one place
  queues.ts      (86)   Queue instances + enqueue*/register* helpers
workers/
  main.ts             (31)   The worker-process entrypoint
  embedding-worker.ts (74)   Computes + writes NodeDefinition.embedding
  validation-worker.ts (88)  Read-only periodic catalog-integrity sweep
  archival-worker.ts  (58)   Sets WorkflowVersion.archivedAt
```

## Why a queue at all, for a 5-row catalog and a handful of workflows?

None of these three jobs is "necessary" at this data scale — a 5-row catalog re-embeds in
milliseconds, and a full-table validation sweep over a handful of workflows is instant. The
point is architectural: each of these is a job that's conceptually *off the request path*
(a chat request shouldn't block on re-embedding the whole catalog, and a periodic sweep
shouldn't run inline with any one user's turn), and BullMQ + a shared `Job` table is the
one real piece of infrastructure that demonstrates "how does this app do background work"
— the same infrastructure a genuinely expensive job (a real embeddings API call, a
heavyweight nightly report) would reuse without a redesign.

## The shared plumbing: one `Job` table, one enqueue pattern

```ts
// apps/backend/src/queues/queue-names.ts (full file, 23 lines)
export const QUEUE = { embedding: "embedding", validation: "validation", archival: "archival" } as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface EmbeddingJobPayload { nodeType: string; }
export interface ValidationJobPayload { triggeredBy: "scheduled" | "manual"; }
export interface ArchivalJobPayload { triggeredBy: "scheduled" | "manual"; }
```

Every producer and consumer imports the same `QUEUE` constant, so a typo'd queue name can't
silently create a queue nobody's `Worker` is listening on (`queue-names.ts:1-3`'s comment).

### `job-store.ts` — the durable audit mirror

```ts
// apps/backend/src/queues/job-store.ts:11-22 (upsertPending)
export async function upsertPending(idempotencyKey: string, type: string, payload: unknown): Promise<void> {
  await prisma.job.upsert({
    where: { idempotencyKey },
    create: { idempotencyKey, type, status: "pending", payload },
    update: { status: "pending", payload, attempts: 0, lastError: null },
  });
}
```

Every `Job`-table write goes through one of four functions here: `upsertPending`,
`markProcessing`, `markDone(idempotencyKey, note?)`, `markFailed(..., deadLettered)`. Note
`markDone`'s `note` parameter (`job-store.ts:34-45`) — it writes into the `lastError` column
even on success, a pragmatic reuse of that column as "last diagnostic message." That's
exactly how the validation worker reports its findings (below): the sweep always
*succeeds* as a job, but its `lastError` field carries what it found. The three `mark*`
functions are all `.catch(() => undefined)`-guarded (`job-store.ts:24-27`'s comment) —
they're best-effort bookkeeping on top of BullMQ's own retry mechanics, so a transient DB
hiccup writing the audit row must never crash the worker or block the actual job.

### `queues.ts` — enqueue helpers, and why hyphens not colons

```ts
// apps/backend/src/queues/queues.ts:45-49 (enqueueEmbedding, one representative example)
export async function enqueueEmbedding(nodeType: string): Promise<void> {
  const idempotencyKey = `embedding-${nodeType}`;
  await upsertPending(idempotencyKey, QUEUE.embedding, { nodeType });
  await getEmbeddingQueue().add("embed", { nodeType }, { ...DEFAULT_JOB_OPTS, jobId: idempotencyKey });
}
```

The same `idempotencyKey` is used as **both** the `Job` table's unique key **and** BullMQ's
own `jobId` (`queues.ts:1-8`'s comment) — so re-enqueuing an identical logical job is a
no-op on both sides at once. Keys use `-` as a separator, never `:` — BullMQ reserves `:`
for its own internal Redis key namespacing and rejects a `jobId` containing one (a real bug
hit and fixed during this build — see `REMAINING.md`'s history). `DEFAULT_JOB_OPTS`
(`queues.ts:15-23`): 3 attempts, exponential backoff starting at 1000ms,
`removeOnComplete: true` (BullMQ's own record is transient — the `Job` table is the durable
one), `removeOnFail: false` (kept in BullMQ's own failed set purely as a debugging
convenience).

`registerArchivalRepeatable` (`queues.ts:64-74`) uses BullMQ's native `repeat: { pattern:
cronPattern }` instead of `DEFAULT_JOB_OPTS` — no separate cron library needed, and it's
safe to call on every worker boot: the same repeat config + fixed `jobId`
(`"archival-repeatable"`) is a no-op if already registered.

## `workers/main.ts` — the entrypoint that ties all three together

```ts
// apps/backend/src/workers/main.ts:12-29 (full main function)
async function main(): Promise<void> {
  const embeddingWorker = startEmbeddingWorker();
  const validationWorker = startValidationWorker();
  const archivalWorker = startArchivalWorker();

  await registerArchivalRepeatable(env.ARCHIVE_CRON);
  const backfilled = await enqueueMissingEmbeddings();
  console.warn(`worker: started ...; enqueued ${backfilled} missing embedding(s); archival cron="${env.ARCHIVE_CRON}"`);

  const shutdown = async (): Promise<void> => {
    await Promise.all([embeddingWorker.close(), validationWorker.close(), archivalWorker.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
```

This is genuinely a separate OS process from the API server — run it locally with `pnpm
--filter @zoft/backend worker` (`package.json`'s `"worker": "tsx watch src/workers/main.ts"`
script), or as the `worker` service in Docker Compose (`14-ops-and-docker.md`). On boot it:
starts all three `Worker` instances, registers the archival cron job, and backfills
embeddings for any catalog row that doesn't have one yet (`enqueueMissingEmbeddings`, below)
— then handles `SIGTERM`/`SIGINT` for a clean shutdown (`Worker.close()` lets in-flight jobs
finish before exiting).

## Worker 1 — embedding

```ts
// apps/backend/src/workers/embedding-worker.ts:37-65 (abridged)
export function startEmbeddingWorker(): Worker<EmbeddingJobPayload> {
  const worker = new Worker<EmbeddingJobPayload>(QUEUE.embedding, async (job) => {
    await markProcessing(jobKey(job));
    const row = await prisma.nodeDefinition.findUnique({ where: { type: job.data.nodeType } });
    if (!row) throw new Error(`node_definition "${job.data.nodeType}" not found`);

    const literal = toVectorLiteral(embedder.embed(documentFor(row)));
    await prisma.$executeRaw`UPDATE node_definition SET embedding = ${literal}::vector WHERE type = ${job.data.nodeType}`;
    invalidateCatalogCache();

    await markDone(jobKey(job));
  }, { connection: getBullConnection(), concurrency: env.WORKER_CONCURRENCY });

  worker.on("failed", (job, err) => {
    if (!job) return;
    const deadLettered = job.attemptsMade >= (job.opts.attempts ?? 1);
    void markFailed(jobKey(job), err.message, deadLettered);
  });
  return worker;
}
```

**What it does**: for a `NodeDefinition` row, builds a text document
(`documentFor`, `embedding-worker.ts:24-31`: `displayName + description + provider + type`
— chosen because it gives the richest signal for a keyword-free vector match), embeds it
with `MockEmbedder` (`07-agent-and-providers.md`), and writes the vector back via a raw SQL
`UPDATE ... ::vector` cast (Prisma has no native vector column type, hence
`$executeRaw`). `invalidateCatalogCache()` (`catalog/catalog-service.ts`) clears the
in-memory catalog cache so the next `search_nodes` call sees the fresh embedding.

**Checked against the core invariant**: this is the *only* code (besides
`prisma/seed.ts`'s initial insert) that ever writes `NodeDefinition.embedding`
(`embedding-worker.ts:1-7`'s comment) — it never touches a `Workflow` or `WorkflowVersion`
row, so it has no bearing on the single-writer rule at all.

**`enqueueMissingEmbeddings`** (`embedding-worker.ts:68-74`) — called once on worker boot
(`main.ts:18`): scans for any catalog row with `embedding IS NULL` and enqueues one job per
row. This is what makes a fresh `docker compose up` end up with a fully-embedded catalog
without a manual step.

## Worker 2 — validation (read-only, by design)

```ts
// apps/backend/src/workers/validation-worker.ts:29-48 (the two pure, exported functions)
export function collectFindings(
  workflows: Array<{ id: string; graph: WorkflowGraph }>,
  catalogEntries: CatalogEntry[],
): Finding[] {
  const findings: Finding[] = [];
  for (const workflow of workflows) {
    const result = validateGraph(workflow.graph, catalogEntries);
    if (!result.valid) findings.push({ workflowId: workflow.id, errorCodes: result.errors.map((e) => e.code) });
  }
  return findings;
}

export function summarize(findings: Finding[]): string | undefined {
  if (findings.length === 0) return undefined;
  const detail = findings.map((f) => `${f.workflowId} [${f.errorCodes.join(", ")}]`).join("; ");
  return `Found ${findings.length} workflow(s) failing validation against the current catalog: ${detail}`;
}
```

**Why this worker needs to exist at all**: per-request validation
(`06-deterministic-core.md`'s `validateGraph`) already runs synchronously and fast at
propose/commit time — so a "heavy validation" worker would be manufactured busywork *unless*
it answers a genuinely different question. This one does: **the catalog itself can change
after a workflow was created** — a node type's config schema tightens, or a type is retired
— silently leaving a persisted graph that would no longer validate if it were proposed
today. Nothing re-checks that on its own; this periodic sweep does.

`collectFindings` and `summarize` are both exported as **pure functions** specifically so
they're unit-testable without a database (`13-testing.md`) — the actual worker body
(`sweepAllWorkflows`, `validation-worker.ts:50-63`) is just "load every workflow with a
current version, call `collectFindings`, `summarize` the result."

**Checked against the core invariant**: this is the one worker whose entire job is to be
**read-only**. It calls `validateGraph` (the same pure function from
`06-deterministic-core.md`) and writes only to `Job.lastError` via `markDone`'s `note`
parameter — never `applyVersion`, never anything on `Workflow`/`WorkflowVersion`. If a
catalog change silently breaks a workflow, this job *reports* it; a human has to actually
edit the workflow through the normal chat flow (which re-validates and re-proposes) to fix
it. The file's own header comment (`validation-worker.ts:1-10`) states this as a hard rule,
not an implementation detail: "It never writes to any workflow or version —
core/version-applier.ts remains the only writer of those."

## Worker 3 — archival

```ts
// apps/backend/src/workers/archival-worker.ts:18-26 (the two pure functions)
export function cutoffDate(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function isArchivable(createdAt: Date, now: Date, days: number): boolean {
  return createdAt.getTime() < cutoffDate(now, days).getTime();
}
```

```ts
// apps/backend/src/workers/archival-worker.ts:35-45 (the worker body)
await markProcessing(jobKey(job));
const cutoff = cutoffDate(new Date(), env.ARCHIVE_AFTER_DAYS);
const result = await prisma.workflowVersion.updateMany({
  where: { archivedAt: null, createdAt: { lt: cutoff } },
  data: { archivedAt: new Date() },
});
await markDone(jobKey(job), `Archived ${result.count} version(s) older than ${env.ARCHIVE_AFTER_DAYS} days.`);
```

**What it does**: per PRD v1.1 Decision #3 ("retain all versions indefinitely, archive
those older than 90 days"), a single `updateMany` sets `archivedAt` on every
`WorkflowVersion` row older than the cutoff that hasn't been archived yet. `cutoffDate` and
`isArchivable` are extracted as pure functions purely so the boundary math (is a version
created exactly at the cutoff instant archivable or not?) is unit-testable without a real
clock or database.

**Checked against the core invariant**: `archivedAt` is a lifecycle annotation on an
already-immutable row, set by a direct, narrow `UPDATE` on exactly one non-content column —
never `graph`/`version`/`createdBy`/`changeSummary`/`parentVersionId`, and never through
`core/version-applier.ts` (`archival-worker.ts:1-8`'s comment, and see
`schema.prisma`'s doc comment on the column itself, `04-data-model.md`). No read endpoint
filters on `archivedAt` or exposes it in any DTO today — it's purely a backend bookkeeping
field this pass (`REMAINING.md` documents an opt-in `?includeArchived=` filter as a
deliberately-deferred future option).

## Running and observing the workers locally

```bash
pnpm --filter @zoft/backend worker      # starts the worker process (tsx watch)
```

To watch it work: the console log on boot reports how many embeddings it backfilled
(`main.ts:19-21`). To inspect the `Job` table directly (e.g. via `pnpm --filter @zoft/backend
exec prisma studio`), look at `status` (`pending`/`processing`/`done`/`failed`/
`dead_lettered`) and `lastError` — for the validation worker, `lastError` on a `done` job is
its findings summary, not an actual error. To force a sweep or archival pass on demand
rather than waiting for the schedule, call `enqueueValidationSweep("manual")` or
`enqueueArchivalNow()` (`queues/queues.ts`) from a REPL or a small script — there's no
existing HTTP route that triggers either manually (see `15-extending.md` if you want to add
one).

---
**Prev:** [`08-api-and-runs.md`](./08-api-and-runs.md) · **Next:**
[`10-frontend.md`](./10-frontend.md) · **Related:**
[`03-the-core-invariant.md`](./03-the-core-invariant.md),
[`14-ops-and-docker.md`](./14-ops-and-docker.md)
