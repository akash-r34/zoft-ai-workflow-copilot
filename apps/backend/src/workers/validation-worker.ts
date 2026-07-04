// BullMQ worker: a periodic, READ-ONLY catalog-integrity sweep. Per-request
// validation (core/validator.ts, run inline during propose_operations and
// commit) is already synchronous and fast, so this worker exists for a
// genuinely different, async-shaped concern: the catalog can change after a
// workflow was created — a node type's config schema tightens, or a type is
// retired — silently leaving a persisted graph that would no longer
// validate if it were proposed today. This job re-validates every
// workflow's CURRENT graph against the LIVE catalog and reports what it
// finds via the Job row's lastError. It never writes to any workflow or
// version — core/version-applier.ts remains the only writer of those.
import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { loadCatalog, toCatalogEntries } from "../catalog/catalog-service.js";
import { validateGraph } from "../core/validator.js";
import type { CatalogEntry, WorkflowGraph } from "../core/types.js";
import { getBullConnection } from "../redis/connection.js";
import { markDone, markFailed, markProcessing } from "../queues/job-store.js";
import { QUEUE } from "../queues/queue-names.js";
import type { ValidationJobPayload } from "../queues/queue-names.js";

export interface Finding {
  workflowId: string;
  errorCodes: string[];
}

/** Pure: re-validates each workflow's graph against the given catalog and collects the ones that no longer pass. Exported for unit testing without a database. */
export function collectFindings(
  workflows: Array<{ id: string; graph: WorkflowGraph }>,
  catalogEntries: CatalogEntry[],
): Finding[] {
  const findings: Finding[] = [];
  for (const workflow of workflows) {
    const result = validateGraph(workflow.graph, catalogEntries);
    if (!result.valid) {
      findings.push({ workflowId: workflow.id, errorCodes: result.errors.map((e) => e.code) });
    }
  }
  return findings;
}

/** Pure: renders findings into the human-readable string stored in Job.lastError, or undefined when the catalog is clean. Exported for unit testing. */
export function summarize(findings: Finding[]): string | undefined {
  if (findings.length === 0) return undefined;
  const detail = findings.map((f) => `${f.workflowId} [${f.errorCodes.join(", ")}]`).join("; ");
  return `Found ${findings.length} workflow(s) failing validation against the current catalog: ${detail}`;
}

async function sweepAllWorkflows(): Promise<Finding[]> {
  const catalogEntries = toCatalogEntries(await loadCatalog(prisma));
  const rows = await prisma.workflow.findMany({
    where: { currentVersionId: { not: null } },
    include: { currentVersion: true },
  });
  const workflows = rows
    .filter((w) => w.currentVersion !== null)
    .map((w) => ({
      id: w.id,
      graph: w.currentVersion?.graph as unknown as WorkflowGraph,
    }));
  return collectFindings(workflows, catalogEntries);
}

function jobKey(job: Job<ValidationJobPayload>): string {
  return job.id ?? `validation-${Date.now()}`;
}

export function startValidationWorker(): Worker<ValidationJobPayload> {
  const worker = new Worker<ValidationJobPayload>(
    QUEUE.validation,
    async (job) => {
      await markProcessing(jobKey(job));
      const findings = await sweepAllWorkflows();
      await markDone(jobKey(job), summarize(findings));
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
