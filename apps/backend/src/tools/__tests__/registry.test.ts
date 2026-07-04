import { describe, expect, it } from "vitest";
import type { NodeDefinitionDto } from "@zoft/contract";
import { toCatalogEntries } from "../../catalog/catalog-service.js";
import { executeTool } from "../registry.js";
import type { ToolContext } from "../types.js";

const CATALOG: NodeDefinitionDto[] = [
  {
    type: "stripe.payment_received",
    category: "trigger",
    displayName: "Stripe: Payment Received",
    description: "Fires when Stripe receives a payment.",
    provider: "stripe",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    inputs: [],
    outputs: [{ name: "payment", type: "stripe.Payment" }],
  },
];

function ctx(): ToolContext {
  return {
    prisma: undefined as unknown as ToolContext["prisma"],
    workflowId: "wf-1",
    catalog: CATALOG,
    catalogEntries: toCatalogEntries(CATALOG),
    currentGraph: { nodes: [], edges: [] },
  };
}

describe("executeTool", () => {
  it("dispatches search_nodes", () => {
    const result = executeTool(ctx(), "search_nodes", { query: "stripe" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toEqual(["stripe.payment_received"]);
  });

  it("dispatches get_node_schema", () => {
    const result = executeTool(ctx(), "get_node_schema", { type: "stripe.payment_received" });
    expect(result.ok).toBe(true);
  });

  it("get_node_schema fails cleanly for an unknown type", () => {
    const result = executeTool(ctx(), "get_node_schema", { type: "does.not.exist" });
    expect(result.ok).toBe(false);
  });

  it("dispatches get_current_workflow", () => {
    const result = executeTool(ctx(), "get_current_workflow", {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toMatchObject({ nodeCount: 0 });
  });

  it("dispatches propose_operations and returns the validator's outcome", () => {
    const result = executeTool(ctx(), "propose_operations", {
      ops: [
        {
          op: "add_node",
          node: { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toMatchObject({ valid: true });
  });

  it("reliability failure mode #3 — an unrecognized tool name returns ok:false naming the allowed set, not a thrown error", () => {
    const result = executeTool(ctx(), "delete_everything", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unknown tool");
      expect(result.error).toContain("search_nodes");
    }
  });
});
