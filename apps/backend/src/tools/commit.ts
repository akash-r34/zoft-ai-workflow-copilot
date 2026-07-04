// The ONLY function in the request/agent path that writes a workflow graph.
// A thin, deliberately un-clever wrapper around core/version-applier.ts's
// applyVersion — kept as its own module so the write boundary stays visually
// obvious (grep for "version-applier" and this file is the only agent-facing
// hit). Called exclusively from routes/runs.ts's POST /approve handler,
// itself only reachable after a human has approved the proposal produced by
// tools/propose-operations.ts. Never called by agent/orchestrator.ts directly.
import type { PrismaClient } from "@prisma/client";
import { applyVersion } from "../core/version-applier.js";
import type { CatalogEntry, Operation, ValidationError, WorkflowGraph } from "../core/types.js";

export function commitProposal(
  prisma: PrismaClient,
  workflowId: string,
  ops: Operation[],
  catalog: CatalogEntry[],
  changeSummary: string,
): Promise<{ version: number; graph: WorkflowGraph } | { error: ValidationError[] }> {
  return applyVersion(prisma, workflowId, ops, catalog, "ai", changeSummary);
}
