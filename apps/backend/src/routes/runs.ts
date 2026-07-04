// GET /api/runs/:runId/stream, POST .../cancel, and the two approval-gate
// endpoints added for PRD v1.1 Decision #1: POST .../approve and .../reject.
// Approve is the ONLY route handler in the whole backend that calls
// tools/commit.ts — the single write path stays reachable exclusively
// through a human decision, never directly from the agent loop.
import type { FastifyInstance } from "fastify";
import type {
  ApproveRunResponseDto,
  Operation,
  RejectRunResponseDto,
  WorkflowGraph,
} from "@zoft/contract";
import { EMPTY_GRAPH } from "@zoft/contract";
import { prisma } from "../db/prisma.js";
import { loadCatalog, toCatalogEntries } from "../catalog/catalog-service.js";
import { commitProposal } from "../tools/commit.js";
import { diffGraphs } from "../dto/diff.js";
import { appendEvent, clearRunState } from "../runs/event-bus.js";
import { streamRun } from "../runs/sse.js";
import { ApiErrorException } from "./errors.js";

export function registerRunRoutes(app: FastifyInstance): void {
  app.get("/api/runs/:runId/stream", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await prisma.run.findUnique({ where: { id: runId } });
    if (!run) {
      await reply.code(404).send({ error: { code: "RUN_NOT_FOUND", message: `run ${runId} not found` } });
      return;
    }
    await streamRun(request, reply, runId);
  });

  app.post("/api/runs/:runId/cancel", async (request): Promise<{ status: "cancelled" }> => {
    const { runId } = request.params as { runId: string };
    const run = await prisma.run.findUnique({ where: { id: runId } });
    if (!run) throw new ApiErrorException("RUN_NOT_FOUND", `run ${runId} not found`, 404);
    await prisma.run.update({ where: { id: runId }, data: { cancelRequested: true } });
    return { status: "cancelled" };
  });

  app.post("/api/runs/:runId/approve", async (request): Promise<ApproveRunResponseDto> => {
    const { runId } = request.params as { runId: string };
    const run = await prisma.run.findUnique({ where: { id: runId }, include: { conversation: true } });
    if (!run) throw new ApiErrorException("RUN_NOT_FOUND", `run ${runId} not found`, 404);
    if (run.proposalStatus !== "pending") {
      throw new ApiErrorException(
        "VALIDATION_FAILED",
        `run ${runId} has no pending proposal to approve`,
        400,
      );
    }
    const workflowId = run.conversation.workflowId;
    if (!workflowId) {
      throw new ApiErrorException("WORKFLOW_NOT_FOUND", `run ${runId} has no associated workflow`, 404);
    }

    const before = await prisma.workflow.findUnique({
      where: { id: workflowId },
      include: { currentVersion: true },
    });
    const beforeGraph: WorkflowGraph =
      (before?.currentVersion?.graph as unknown as WorkflowGraph | undefined) ?? EMPTY_GRAPH;

    const catalog = toCatalogEntries(await loadCatalog(prisma));
    const ops = run.proposedOps as unknown as Operation[];
    const summary = run.proposalSummary ?? "Applied AI-proposed change";
    const result = await commitProposal(prisma, workflowId, ops, catalog, summary);

    if ("error" in result) {
      // Only reachable if the workflow changed between propose and approve
      // (re-validated at commit time, per the invariant) — the original
      // proposal already passed validation once.
      await prisma.run.update({ where: { id: runId }, data: { status: "failed" } });
      await appendEvent(runId, { event: "validation.error", data: { errors: result.error } });
      await appendEvent(runId, {
        event: "run.failed",
        data: {
          runId,
          error: {
            code: "VALIDATION_FAILED",
            message: "The proposal no longer validates against the current workflow.",
          },
        },
      });
      await clearRunState(runId);
      throw new ApiErrorException(
        "VALIDATION_FAILED",
        "The proposal no longer validates against the current workflow.",
        409,
      );
    }

    const diff = diffGraphs(beforeGraph, result.graph);
    await prisma.run.update({
      where: { id: runId },
      data: { proposalStatus: "approved", status: "succeeded" },
    });
    await appendEvent(runId, {
      event: "workflow.updated",
      data: { workflowId, version: result.version, graph: result.graph, diff },
    });
    await appendEvent(runId, { event: "run.completed", data: { runId } });
    await clearRunState(runId);

    return { status: "approved", version: result.version };
  });

  app.post("/api/runs/:runId/reject", async (request): Promise<RejectRunResponseDto> => {
    const { runId } = request.params as { runId: string };
    const run = await prisma.run.findUnique({ where: { id: runId } });
    if (!run) throw new ApiErrorException("RUN_NOT_FOUND", `run ${runId} not found`, 404);
    if (run.proposalStatus !== "pending") {
      throw new ApiErrorException(
        "VALIDATION_FAILED",
        `run ${runId} has no pending proposal to reject`,
        400,
      );
    }

    await prisma.run.update({
      where: { id: runId },
      data: { proposalStatus: "rejected", status: "succeeded" },
    });
    await prisma.message.create({
      data: {
        conversationId: run.conversationId,
        role: "assistant",
        content: "Change discarded — nothing was applied.",
        runId,
      },
    });
    await appendEvent(runId, { event: "run.completed", data: { runId } });
    await clearRunState(runId);

    return { status: "rejected" };
  });
}
