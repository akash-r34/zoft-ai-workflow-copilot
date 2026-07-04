// Every write to the `job` table (see schema.prisma's Job model — modeled
// ahead of time in Phase 1 for exactly this) goes through here, so
// BullMQ's own job lifecycle and our durable audit row stay in one place.
// BullMQ handles the actual retry/backoff mechanics; this table is a
// human/db-queryable mirror of "what happened," keyed by the same
// idempotencyKey used as the BullMQ jobId (queues.ts) so re-enqueuing the
// same logical job is a no-op on both sides.
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";

export async function upsertPending(idempotencyKey: string, type: string, payload: unknown): Promise<void> {
  await prisma.job.upsert({
    where: { idempotencyKey },
    create: { idempotencyKey, type, status: "pending", payload: payload as Prisma.InputJsonValue },
    update: {
      status: "pending",
      payload: payload as Prisma.InputJsonValue,
      attempts: 0,
      lastError: null,
    },
  });
}

// The mark* functions below are best-effort bookkeeping: BullMQ's own
// attempts/backoff already governs retry behavior, so a failure to write
// this audit mirror (e.g. a transient DB hiccup) must never crash the
// worker or block the job from completing/retrying.
export async function markProcessing(idempotencyKey: string): Promise<void> {
  await prisma.job
    .update({ where: { idempotencyKey }, data: { status: "processing" } })
    .catch(() => undefined);
}

/**
 * Marks a job done. `note`, if given, is written into `lastError` even
 * though the job succeeded — a pragmatic reuse of that column as "last
 * diagnostic message" for jobs whose success can still carry findings worth
 * surfacing (workers/validation-worker.ts's catalog-integrity sweep: the
 * sweep itself always completes; `note` is where it reports what it found).
 */
export async function markDone(idempotencyKey: string, note?: string): Promise<void> {
  await prisma.job
    .update({ where: { idempotencyKey }, data: { status: "done", lastError: note ?? null } })
    .catch(() => undefined);
}

export async function markFailed(idempotencyKey: string, error: string, deadLettered: boolean): Promise<void> {
  await prisma.job
    .update({
      where: { idempotencyKey },
      data: {
        status: deadLettered ? "dead_lettered" : "failed",
        lastError: error,
        attempts: { increment: 1 },
      },
    })
    .catch(() => undefined);
}
