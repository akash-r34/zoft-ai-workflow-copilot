// BullMQ worker: computes and writes back a node_definition's embedding via
// the deterministic MockEmbedder. This — plus prisma/seed.ts's original
// catalog insert — is the only code that ever writes
// `node_definition.embedding`; nothing here touches a workflow graph or
// version, so it doesn't affect the single-writer invariant
// (core/version-applier.ts remains the only writer of those). Runs off the
// request path so search_nodes never blocks on embedding computation.
import type { Job } from "bullmq";
import { Worker } from "bullmq";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { invalidateCatalogCache } from "../catalog/catalog-service.js";
import { MockEmbedder } from "../embeddings/mock-embedder.js";
import { toVectorLiteral } from "../embeddings/serialize.js";
import { getBullConnection } from "../redis/connection.js";
import { markDone, markFailed, markProcessing } from "../queues/job-store.js";
import { QUEUE } from "../queues/queue-names.js";
import type { EmbeddingJobPayload } from "../queues/queue-names.js";
import { enqueueEmbedding } from "../queues/queues.js";

const embedder = new MockEmbedder();

/** The text representation of a catalog row that gets embedded — display name + description + provider + type give the richest signal for a keyword-free vector match. */
function documentFor(row: {
  displayName: string;
  description: string;
  provider: string;
  type: string;
}): string {
  return `${row.displayName} ${row.description} ${row.provider} ${row.type}`;
}

function jobKey(job: Job<EmbeddingJobPayload>): string {
  return job.id ?? `embedding-${job.data.nodeType}`;
}

export function startEmbeddingWorker(): Worker<EmbeddingJobPayload> {
  const worker = new Worker<EmbeddingJobPayload>(
    QUEUE.embedding,
    async (job) => {
      await markProcessing(jobKey(job));

      const row = await prisma.nodeDefinition.findUnique({ where: { type: job.data.nodeType } });
      if (!row) throw new Error(`node_definition "${job.data.nodeType}" not found`);

      const literal = toVectorLiteral(embedder.embed(documentFor(row)));
      await prisma.$executeRaw`
        UPDATE node_definition SET embedding = ${literal}::vector WHERE type = ${job.data.nodeType}
      `;
      invalidateCatalogCache();

      await markDone(jobKey(job));
    },
    { connection: getBullConnection(), concurrency: env.WORKER_CONCURRENCY },
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    const deadLettered = job.attemptsMade >= maxAttempts;
    void markFailed(jobKey(job), err.message, deadLettered);
  });

  return worker;
}

/** Scans the catalog for rows with no embedding yet and enqueues one job per row — called once on worker boot (workers/main.ts). */
export async function enqueueMissingEmbeddings(): Promise<number> {
  const rows = await prisma.$queryRaw<{ type: string }[]>`
    SELECT type FROM node_definition WHERE embedding IS NULL
  `;
  for (const row of rows) await enqueueEmbedding(row.type);
  return rows.length;
}
