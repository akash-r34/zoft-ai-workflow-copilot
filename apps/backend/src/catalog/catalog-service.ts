// Loads the data-driven node catalog (seeded via prisma/seed.ts, see
// CLAUDE.md: "new node types appear with no redeploy") and exposes it in the
// two shapes the rest of the backend needs:
//   - CatalogEntry[]  for the deterministic core (core/validator.ts)
//   - NodeDefinitionDto[] for the REST /api/node-definitions response and the
//     search_nodes tool's grounding results.
// A short in-memory cache avoids re-querying Postgres on every validation
// call within a run; call invalidate() after any catalog write (there are
// none yet at runtime — seeding happens out-of-band via `pnpm db:seed`).
import type { PrismaClient } from "@prisma/client";
import type { CatalogEntry, NodeDefinitionDto } from "@zoft/contract";

let cache: NodeDefinitionDto[] | undefined;

function toDto(row: {
  type: string;
  category: string;
  displayName: string;
  description: string;
  provider: string;
  configSchema: unknown;
  inputs: unknown;
  outputs: unknown;
}): NodeDefinitionDto {
  return {
    type: row.type,
    category: row.category as "trigger" | "action",
    displayName: row.displayName,
    description: row.description,
    provider: row.provider,
    configSchema: row.configSchema as Record<string, unknown>,
    inputs: row.inputs as Array<{ name: string; type: string }>,
    outputs: row.outputs as Array<{ name: string; type: string }>,
  };
}

export async function loadCatalog(prisma: PrismaClient): Promise<NodeDefinitionDto[]> {
  if (cache) return cache;
  const rows = await prisma.nodeDefinition.findMany({ orderBy: { type: "asc" } });
  cache = rows.map(toDto);
  return cache;
}

export function invalidateCatalogCache(): void {
  cache = undefined;
}

/** Projects the REST-facing NodeDefinitionDto[] down to what the deterministic validator needs. */
export function toCatalogEntries(catalog: NodeDefinitionDto[]): CatalogEntry[] {
  return catalog.map((n) => ({
    type: n.type,
    category: n.category,
    configSchema: n.configSchema,
    inputs: n.inputs,
    outputs: n.outputs,
  }));
}

/** Keyword search over type/displayName/provider/description — mirrors apps/frontend/mock/store.ts's getNodeDefinitions. */
export function searchCatalog(catalog: NodeDefinitionDto[], query?: string): NodeDefinitionDto[] {
  if (!query || query.trim().length === 0) return catalog;
  const q = query.toLowerCase();
  return catalog.filter(
    (n) =>
      n.type.toLowerCase().includes(q) ||
      n.displayName.toLowerCase().includes(q) ||
      n.provider.toLowerCase().includes(q) ||
      n.description.toLowerCase().includes(q),
  );
}

export function findCatalogEntry(
  catalog: NodeDefinitionDto[],
  type: string,
): NodeDefinitionDto | undefined {
  return catalog.find((n) => n.type === type);
}

export function isTriggerType(catalog: NodeDefinitionDto[], type: string): boolean {
  return findCatalogEntry(catalog, type)?.category === "trigger";
}
