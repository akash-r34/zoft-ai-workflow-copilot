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
    // undefined prisma is fine here: search_nodes' vector-search attempt
    // (catalog/vector-search.ts) catches any error (including calling
    // $queryRaw on undefined) and falls back to the keyword search these
    // tests exercise — no other tool here touches ctx.prisma.
    prisma: undefined as unknown as ToolContext["prisma"],
    workflowId: "wf-1",
    catalog: CATALOG,
    catalogEntries: toCatalogEntries(CATALOG),
    currentGraph: { nodes: [], edges: [] },
  };
}

describe("executeTool", () => {
  it("dispatches search_nodes", async () => {
    const result = await executeTool(ctx(), "search_nodes", { query: "stripe" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toEqual(["stripe.payment_received"]);
  });

  it("dispatches get_node_schema", async () => {
    const result = await executeTool(ctx(), "get_node_schema", { type: "stripe.payment_received" });
    expect(result.ok).toBe(true);
  });

  it("get_node_schema fails cleanly for an unknown type", async () => {
    const result = await executeTool(ctx(), "get_node_schema", { type: "does.not.exist" });
    expect(result.ok).toBe(false);
  });

  it("dispatches get_current_workflow", async () => {
    const result = await executeTool(ctx(), "get_current_workflow", {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toMatchObject({ nodeCount: 0 });
  });

  it("dispatches propose_operations and returns the validator's outcome", async () => {
    const result = await executeTool(ctx(), "propose_operations", {
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

  it("reliability failure mode #3 — an unrecognized tool name returns ok:false naming the allowed set, not a thrown error", async () => {
    const result = await executeTool(ctx(), "delete_everything", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unknown tool");
      expect(result.error).toContain("search_nodes");
    }
  });
});
