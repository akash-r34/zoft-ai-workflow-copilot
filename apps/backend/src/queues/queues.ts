// Lazily-constructed BullMQ Queue instances + typed enqueue helpers. Each
// enqueue* function does two things: upsertPending a Job row (job-store.ts,
// the durable audit mirror) and queue.add(..., { jobId: idempotencyKey, ... }) —
// passing the SAME idempotencyKey as BullMQ's own jobId means re-enqueuing an
// identical logical job is a no-op on both the BullMQ side (its own dedup)
// and the Job-table side (upsert, not insert). idempotencyKeys use `-` as
// their separator, never `:` — BullMQ rejects a jobId containing a colon
// (it reserves `:` for its own internal Redis key namespacing).
import { Queue } from "bullmq";
import { getBullConnection } from "../redis/connection.js";
import { upsertPending } from "./job-store.js";
import { QUEUE } from "./queue-names.js";
import type { ArchivalJobPayload, EmbeddingJobPayload, ValidationJobPayload } from "./queue-names.js";

const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: true,
  // Keep failed jobs in BullMQ's own failed set for inspection — the `job`
  // table (job-store.ts) is the durable record either way, so this is a
  // debugging convenience, not a second source of truth.
  removeOnFail: false,
};

let embeddingQueue: Queue<EmbeddingJobPayload> | undefined;
export function getEmbeddingQueue(): Queue<EmbeddingJobPayload> {
  embeddingQueue ??= new Queue<EmbeddingJobPayload>(QUEUE.embedding, { connection: getBullConnection() });
  return embeddingQueue;
}

let validationQueue: Queue<ValidationJobPayload> | undefined;
export function getValidationQueue(): Queue<ValidationJobPayload> {
  validationQueue ??= new Queue<ValidationJobPayload>(QUEUE.validation, {
    connection: getBullConnection(),
  });
  return validationQueue;
}

let archivalQueue: Queue<ArchivalJobPayload> | undefined;
export function getArchivalQueue(): Queue<ArchivalJobPayload> {
  archivalQueue ??= new Queue<ArchivalJobPayload>(QUEUE.archival, { connection: getBullConnection() });
  return archivalQueue;
}

export async function enqueueEmbedding(nodeType: string): Promise<void> {
  const idempotencyKey = `embedding-${nodeType}`;
  await upsertPending(idempotencyKey, QUEUE.embedding, { nodeType } satisfies EmbeddingJobPayload);
  await getEmbeddingQueue().add("embed", { nodeType }, { ...DEFAULT_JOB_OPTS, jobId: idempotencyKey });
}

export async function enqueueValidationSweep(triggeredBy: "scheduled" | "manual"): Promise<void> {
  // One logical job per calendar day keeps re-triggers (e.g. a manual kick
  // right after the scheduled run) from piling up duplicate sweeps.
  const idempotencyKey = `validation-${new Date().toISOString().slice(0, 10)}`;
  await upsertPending(idempotencyKey, QUEUE.validation, { triggeredBy } satisfies ValidationJobPayload);
  await getValidationQueue().add(
    "sweep",
    { triggeredBy },
    { ...DEFAULT_JOB_OPTS, jobId: idempotencyKey },
  );
}

/** Registers the archival job as a BullMQ repeatable (cron-scheduled) job — idempotent to call on every worker boot: the same repeat config + jobId is a no-op if already registered. */
export async function registerArchivalRepeatable(cronPattern: string): Promise<void> {
  const idempotencyKey = "archival-repeatable";
  await upsertPending(idempotencyKey, QUEUE.archival, {
    triggeredBy: "scheduled",
  } satisfies ArchivalJobPayload);
  await getArchivalQueue().add(
    "archive",
    { triggeredBy: "scheduled" },
    { jobId: idempotencyKey, repeat: { pattern: cronPattern } },
  );
}

export async function enqueueArchivalNow(): Promise<void> {
  const idempotencyKey = `archival-manual-${Date.now()}`;
  await upsertPending(idempotencyKey, QUEUE.archival, {
    triggeredBy: "manual",
  } satisfies ArchivalJobPayload);
  await getArchivalQueue().add(
    "archive",
    { triggeredBy: "manual" },
    { ...DEFAULT_JOB_OPTS, jobId: idempotencyKey },
  );
}
