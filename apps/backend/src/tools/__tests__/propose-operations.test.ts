import { describe, expect, it } from "vitest";
import type { CatalogEntry, Operation } from "../../core/types.js";
import { proposeOperations } from "../propose-operations.js";
import type { ToolContext } from "../types.js";

const CATALOG: CatalogEntry[] = [
  {
    type: "stripe.payment_received",
    category: "trigger",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    inputs: [],
    outputs: [{ name: "payment", type: "stripe.Payment" }],
  },
  {
    type: "slack.send_message",
    category: "action",
    configSchema: {
      type: "object",
      required: ["channel", "text"],
      properties: { channel: { type: "string" }, text: { type: "string" } },
      additionalProperties: false,
    },
    inputs: [{ name: "trigger", type: "any" }],
    outputs: [],
  },
];

function ctx(currentGraph: ToolContext["currentGraph"] = { nodes: [], edges: [] }): ToolContext {
  return {
    // Only currentGraph and catalogEntries are read by proposeOperations —
    // the rest of ToolContext isn't needed for this pure-validation path.
    prisma: undefined as unknown as ToolContext["prisma"],
    workflowId: "wf-1",
    catalog: [],
    catalogEntries: CATALOG,
    currentGraph,
  };
}

describe("proposeOperations", () => {
  it("returns valid:true with the candidate graph when the ops produce a valid workflow", () => {
    const ops: Operation[] = [
      { op: "add_node", node: { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } } },
      {
        op: "add_node",
        node: {
          id: "a1",
          type: "slack.send_message",
          config: { channel: "#payments", text: "hi" },
          position: { x: 200, y: 0 },
        },
      },
      { op: "add_edge", edge: { id: "e1", source: "t1", target: "a1" } },
    ];
    const outcome = proposeOperations(ctx(), ops);
    expect(outcome.valid).toBe(true);
    if (outcome.valid) expect(outcome.graph.nodes).toHaveLength(2);
  });

  it("returns valid:false with validator errors for a hallucinated node type", () => {
    const ops: Operation[] = [
      { op: "add_node", node: { id: "x1", type: "totally.unknown", config: {}, position: { x: 0, y: 0 } } },
    ];
    const outcome = proposeOperations(ctx(), ops);
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.errors.some((e) => e.code === "UNKNOWN_NODE_TYPE")).toBe(true);
  });

  it("returns valid:false for a config missing a required field", () => {
    const ops: Operation[] = [
      { op: "add_node", node: { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } } },
      {
        op: "add_node",
        node: { id: "a1", type: "slack.send_message", config: { text: "hi" }, position: { x: 200, y: 0 } },
      },
      { op: "add_edge", edge: { id: "e1", source: "t1", target: "a1" } },
    ];
    const outcome = proposeOperations(ctx(), ops);
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.errors.some((e) => e.code === "INVALID_CONFIG")).toBe(true);
  });

  it("never mutates the currentGraph passed in — the candidate is a new object", () => {
    const before = { nodes: [], edges: [] };
    const ops: Operation[] = [
      { op: "add_node", node: { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } } },
    ];
    proposeOperations(ctx(before), ops);
    expect(before.nodes).toHaveLength(0);
  });
});
