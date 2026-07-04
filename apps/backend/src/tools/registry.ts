// Dispatches a tool name + input to its handler. Centralizing this (rather
// than letting the orchestrator switch on tool name itself) is what makes
// reliability failure mode #3 ("calls an invalid tool") a one-line check:
// any name not in this switch's known set falls through to the default case
// below and comes back as a normal ok:false tool.result, not a thrown error.
import type { Operation } from "../core/types.js";
import { getCurrentWorkflow, getNodeSchema, searchNodes } from "./read-tools.js";
import type { SearchNodesInput } from "./read-tools.js";
import { proposeOperations } from "./propose-operations.js";
import type { ToolContext, ToolResult } from "./types.js";

export const KNOWN_TOOLS = [
  "search_nodes",
  "get_node_schema",
  "get_current_workflow",
  "propose_operations",
] as const;
export type ToolName = (typeof KNOWN_TOOLS)[number];

export function executeTool(ctx: ToolContext, tool: string, input: unknown): ToolResult {
  switch (tool as ToolName) {
    case "search_nodes":
      return searchNodes(ctx, (input ?? {}) as SearchNodesInput);
    case "get_node_schema":
      return getNodeSchema(ctx, input as { type: string });
    case "get_current_workflow":
      return getCurrentWorkflow(ctx);
    case "propose_operations": {
      const { ops } = input as { ops: Operation[] };
      return { ok: true, result: proposeOperations(ctx, ops) };
    }
    default:
      return {
        ok: false,
        error: `unknown tool "${tool}"; allowed: ${KNOWN_TOOLS.join(", ")}`,
      };
  }
}
