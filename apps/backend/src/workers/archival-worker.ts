// BullMQ worker: archives (never deletes) workflow_version rows older than
// ARCHIVE_AFTER_DAYS (default 90) — PRD v1.1 Decision #3: retain all
// versions indefinitely, archive those older than 90 days. "Archived" is a
// lifecycle annotation on an already-immutable row (schema.prisma's
// WorkflowVersion.archivedAt doc explains why this doesn't violate the
// append-only/single-writer invariant). Registered as a BullMQ repeatable
// (cron-scheduled) job in workers/main.ts; also runnable on demand via
// queues.ts's enqueueArchivalNow.
import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { getBullConnection } from "../redis/connection.js";
import { markDone, markFailed, markProcessing } from "../queues/job-store.js";
import { QUEUE } from "../queues/queue-names.js";
import type { ArchivalJobPayload } from "../queues/queue-names.js";

/** Pure: the instant at or before which a version is old enough to archive. Single source of truth for both the worker's bulk SQL update and isArchivable's per-row check below. */
export function cutoffDate(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Pure: is a version created at `createdAt` old enough to archive? Exported for unit testing the boundary without a clock or database. */
export function isArchivable(createdAt: Date, now: Date, days: number): boolean {
  return createdAt.getTime() < cutoffDate(now, days).getTime();
}

function jobKey(job: Job<ArchivalJobPayload>): string {
  return job.id ?? `archival-${Date.now()}`;
}

export function startArchivalWorker(): Worker<ArchivalJobPayload> {
  const worker = new Worker<ArchivalJobPayload>(
    QUEUE.archival,
    async (job) => {
      await markProcessing(jobKey(job));
      const cutoff = cutoffDate(new Date(), env.ARCHIVE_AFTER_DAYS);
      const result = await prisma.workflowVersion.updateMany({
        where: { archivedAt: null, createdAt: { lt: cutoff } },
        data: { archivedAt: new Date() },
      });
      await markDone(
        jobKey(job),
        `Archived ${result.count} version(s) older than ${env.ARCHIVE_AFTER_DAYS} days.`,
      );
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
