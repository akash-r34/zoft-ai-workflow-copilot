import type { PrismaClient, Prisma } from "@prisma/client";
import { applyOperations } from "./applier.js";
import { validateGraph } from "./validator.js";
import { EMPTY_GRAPH } from "./types.js";
import type { CatalogEntry, Operation, ValidationError, WorkflowGraph } from "./types.js";

/**
 * Applies a batch of operations to a workflow's current graph and, if the
 * result validates cleanly, persists it as a new immutable `workflow_version`
 * row and repoints `workflow.currentVersionId` at it.
 *
 * This is the **only** function in the codebase that writes a workflow graph
 * to the database — every other write path is forbidden by convention (see
 * CLAUDE.md's "the AI never writes to the database directly" rule). Callers
 * (a Phase 2 service layer, never route handlers directly) must go through
 * this function.
 *
 * Side effects: on a valid result, inserts one `workflow_version` row and
 * updates one `workflow` row, both inside a single transaction. On an
 * invalid result, the transaction commits with zero writes.
 *
 * @param prisma - a PrismaClient (or an object structurally compatible with
 *   the subset of it this function calls — see version-applier.test.ts for
 *   the in-memory fake used in unit tests)
 * @param workflowId - the workflow to apply operations to; must already exist
 * @param ops - operations to apply to the workflow's current graph, in order
 * @param catalog - node catalog to validate the candidate graph against
 * @param createdBy - "user" or "ai", recorded on the new version row
 * @param changeSummary - human-readable summary recorded on the new version row
 * @throws if `workflowId` does not reference an existing workflow
 * @returns `{ version, graph }` for the newly created version on success, or
 *   `{ error }` with the validator's errors — and no writes — on failure
 */
export async function applyVersion(
  prisma: PrismaClient,
  workflowId: string,
  ops: Operation[],
  catalog: CatalogEntry[],
  createdBy: "user" | "ai",
  changeSummary: string,
): Promise<{ version: number; graph: WorkflowGraph } | { error: ValidationError[] }> {
  return prisma.$transaction(async (tx) => {
    const workflow = await tx.workflow.findUnique({
      where: { id: workflowId },
      include: { currentVersion: true },
    });

    if (!workflow) {
      throw new Error(`Workflow "${workflowId}" not found`);
    }

    const currentGraph: WorkflowGraph =
      workflow.currentVersion !== null
        ? (workflow.currentVersion.graph as unknown as WorkflowGraph)
        : EMPTY_GRAPH;

    const candidateGraph = applyOperations(currentGraph, ops);
    const result = validateGraph(candidateGraph, catalog);

    if (!result.valid) {
      return { error: result.errors };
    }

    const agg = await tx.workflowVersion.aggregate({
      where: { workflowId },
      _max: { version: true },
    });
    const nextVersion = (agg._max.version ?? 0) + 1;

    const created = await tx.workflowVersion.create({
      data: {
        workflowId,
        version: nextVersion,
        graph: candidateGraph as unknown as Prisma.InputJsonValue,
        createdBy,
        changeSummary,
        parentVersionId: workflow.currentVersionId,
      },
    });

    await tx.workflow.update({
      where: { id: workflowId },
      data: { currentVersionId: created.id },
    });

    return { version: nextVersion, graph: candidateGraph };
  });
}
