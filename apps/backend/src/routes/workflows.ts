// GET /api/workflows/:id (+ /versions, /versions/:v, /diff), POST /versions/:v/restore.
// Mirrors apps/frontend/mock/server.ts's workflow/version routes.
import type { FastifyInstance } from "fastify";
import type { WorkflowDiffDto, WorkflowDto, WorkflowVersionSummaryDto } from "@zoft/contract";
import { prisma } from "../db/prisma.js";
import { loadCatalog, toCatalogEntries } from "../catalog/catalog-service.js";
import { restoreVersion } from "../core/version-applier.js";
import { diffGraphs, toWorkflowDiffDto } from "../dto/diff.js";
import { toVersionDetailDto, toVersionSummaryDto, toWorkflowDto } from "../dto/mappers.js";
import type { VersionDetailDto } from "../dto/mappers.js";
import { ApiErrorException } from "./errors.js";

export function registerWorkflowRoutes(app: FastifyInstance): void {
  app.get("/api/workflows/:id", async (request): Promise<WorkflowDto> => {
    const { id } = request.params as { id: string };
    const workflow = await prisma.workflow.findUnique({ where: { id }, include: { currentVersion: true } });
    if (!workflow) throw new ApiErrorException("WORKFLOW_NOT_FOUND", `workflow ${id} not found`, 404);
    return toWorkflowDto(workflow, workflow.currentVersion);
  });

  app.get("/api/workflows/:id/versions", async (request): Promise<WorkflowVersionSummaryDto[]> => {
    const { id } = request.params as { id: string };
    const workflow = await prisma.workflow.findUnique({ where: { id } });
    if (!workflow) throw new ApiErrorException("WORKFLOW_NOT_FOUND", `workflow ${id} not found`, 404);
    const versions = await prisma.workflowVersion.findMany({
      where: { workflowId: id },
      orderBy: { version: "desc" },
    });
    return versions.map(toVersionSummaryDto);
  });

  app.get("/api/workflows/:id/versions/:v", async (request): Promise<VersionDetailDto> => {
    const { id, v } = request.params as { id: string; v: string };
    const version = await prisma.workflowVersion.findUnique({
      where: { workflowId_version: { workflowId: id, version: Number(v) } },
    });
    if (!version) {
      throw new ApiErrorException("WORKFLOW_NOT_FOUND", `version ${v} not found for workflow ${id}`, 404);
    }
    return toVersionDetailDto(version);
  });

  app.get("/api/workflows/:id/diff", async (request): Promise<WorkflowDiffDto> => {
    const { id } = request.params as { id: string };
    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to) {
      throw new ApiErrorException("VALIDATION_FAILED", "from and to query params are required", 400);
    }
    const [fromVersion, toVersion] = await Promise.all([
      prisma.workflowVersion.findUnique({
        where: { workflowId_version: { workflowId: id, version: Number(from) } },
      }),
      prisma.workflowVersion.findUnique({
        where: { workflowId_version: { workflowId: id, version: Number(to) } },
      }),
    ]);
    if (!fromVersion || !toVersion) {
      throw new ApiErrorException("WORKFLOW_NOT_FOUND", "one or both versions not found", 404);
    }
    const diff = diffGraphs(
      fromVersion.graph as unknown as Parameters<typeof diffGraphs>[0],
      toVersion.graph as unknown as Parameters<typeof diffGraphs>[1],
    );
    return toWorkflowDiffDto(Number(from), Number(to), diff);
  });

  app.post("/api/workflows/:id/versions/:v/restore", async (request): Promise<VersionDetailDto> => {
    const { id, v } = request.params as { id: string; v: string };
    const workflow = await prisma.workflow.findUnique({ where: { id } });
    if (!workflow) throw new ApiErrorException("WORKFLOW_NOT_FOUND", `workflow ${id} not found`, 404);

    const targetVersion = await prisma.workflowVersion.findUnique({
      where: { workflowId_version: { workflowId: id, version: Number(v) } },
    });
    if (!targetVersion) {
      throw new ApiErrorException("WORKFLOW_NOT_FOUND", `version ${v} not found for workflow ${id}`, 404);
    }

    const catalog = toCatalogEntries(await loadCatalog(prisma));
    const result = await restoreVersion(prisma, id, Number(v), catalog);
    if ("error" in result) {
      throw new ApiErrorException(
        "VALIDATION_FAILED",
        `Version ${v} no longer validates against the current catalog and cannot be restored.`,
        409,
      );
    }

    const restored = await prisma.workflowVersion.findUniqueOrThrow({
      where: { workflowId_version: { workflowId: id, version: result.version } },
    });
    return toVersionDetailDto(restored);
  });
}
