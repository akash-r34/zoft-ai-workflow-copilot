// The three read-only tools. None of these ever writes — grounding
// (search_nodes) and inspection (get_node_schema, get_current_workflow) are
// the only way the agent learns about the world before it proposes a change.
import { findCatalogEntry, searchCatalog } from "../catalog/catalog-service.js";
import type { ToolContext, ToolResult } from "./types.js";

export interface SearchNodesInput {
  query?: string;
  /** Demo-only fault injection for the "tool_failure" reliability scenario — mirrors apps/frontend/mock/scenarios.ts's runToolFailureScenario, which fails the first call and succeeds on retry. Never set by a real provider. */
  _simulateFailure?: boolean;
}

export function searchNodes(ctx: ToolContext, input: SearchNodesInput): ToolResult {
  if (input._simulateFailure) {
    return { ok: false, error: "node search index temporarily unavailable" };
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
