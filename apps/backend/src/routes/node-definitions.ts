// GET /api/node-definitions?query= — the same node catalog search the
// search_nodes tool and apps/frontend/mock/store.ts's getNodeDefinitions use,
// exposed as its own endpoint for the frontend's node picker / catalog browser.
import type { FastifyInstance } from "fastify";
import type { NodeDefinitionDto } from "@zoft/contract";
import { prisma } from "../db/prisma.js";
import { loadCatalog, searchCatalog } from "../catalog/catalog-service.js";

export function registerNodeDefinitionRoutes(app: FastifyInstance): void {
  app.get("/api/node-definitions", async (request): Promise<NodeDefinitionDto[]> => {
    const { query } = request.query as { query?: string };
    const catalog = await loadCatalog(prisma);
    return searchCatalog(catalog, query);
  });
}
