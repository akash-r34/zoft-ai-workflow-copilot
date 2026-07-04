// The three read-only tools. None of these ever writes — grounding
// (search_nodes) and inspection (get_node_schema, get_current_workflow) are
// the only way the agent learns about the world before it proposes a change.
import { findCatalogEntry, searchCatalog } from "../catalog/catalog-service.js";
import { searchNodesByVector } from "../catalog/vector-search.js";
import { MockEmbedder } from "../embeddings/mock-embedder.js";
import type { ToolContext, ToolResult } from "./types.js";

const embedder = new MockEmbedder();

export interface SearchNodesInput {
  query?: string;
  /** Demo-only fault injection for the "tool_failure" reliability scenario — mirrors apps/frontend/mock/scenarios.ts's runToolFailureScenario, which fails the first call and succeeds on retry. Never set by a real provider. */
  _simulateFailure?: boolean;
}

/**
 * Semantic (pgvector) search first, keyword fallback second. The vector
 * path returns [] — not an error — whenever nothing has an embedding yet
 * (before workers/embedding-worker.ts's backfill has run) or nothing scores
 * a match, so falling back to the always-available keyword search
 * (catalog-service.ts's searchCatalog) is the normal, expected path until
 * the catalog is fully embedded, not a failure condition.
 */
export async function searchNodes(ctx: ToolContext, input: SearchNodesInput): Promise<ToolResult> {
  if (input._simulateFailure) {
    return { ok: false, error: "node search index temporarily unavailable" };
  }

  if (input.query) {
    const vectorMatches = await searchNodesByVector(ctx.prisma, embedder, input.query, 5);
    if (vectorMatches.length > 0) return { ok: true, result: vectorMatches };
  }

  const matches = searchCatalog(ctx.catalog, input.query).map((n) => n.type);
  return { ok: true, result: matches.length > 0 ? matches : ctx.catalog.map((n) => n.type) };
}

export function getNodeSchema(ctx: ToolContext, input: { type: string }): ToolResult {
  const entry = findCatalogEntry(ctx.catalog, input.type);
  if (!entry) return { ok: false, error: `unknown node type "${input.type}"` };
  return { ok: true, result: entry.configSchema };
}

export function getCurrentWorkflow(ctx: ToolContext): ToolResult {
  return {
    ok: true,
    result: { nodeCount: ctx.currentGraph.nodes.length, graph: ctx.currentGraph },
  };
}
