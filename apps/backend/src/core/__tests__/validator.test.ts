import { describe, it, expect } from "vitest";
import { validateGraph } from "../validator.js";
import type { CatalogEntry, WorkflowGraph, WorkflowNode } from "../types.js";

const CATALOG: CatalogEntry[] = [
  {
    type: "stripe.payment_received",
    category: "trigger",
    configSchema: {
      type: "object",
      properties: { currency: { type: "string", default: "usd" } },
      additionalProperties: false,
    },
    inputs: [],
    outputs: [{ name: "payment", type: "stripe.Payment" }],
  },
  {
    type: "slack.send_message",
    category: "action",
    configSchema: {
      type: "object",
      required: ["channel", "text"],
      properties: {
        channel: { type: "string" },
        text: { type: "string" },
      },
      additionalProperties: false,
    },
    inputs: [{ name: "trigger", type: "any" }],
    outputs: [],
  },
  {
    type: "filter.condition",
    category: "action",
    configSchema: {
      type: "object",
      required: ["field", "op", "value"],
      properties: {
        field: { type: "string" },
        op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte"] },
        value: {},
      },
      additionalProperties: false,
    },
    inputs: [{ name: "value", type: "any" }],
    outputs: [{ name: "passed", type: "any" }],
  },
];

function trigger(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: "trigger1",
    type: "stripe.payment_received",
    config: {},
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

function action(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: "action1",
    type: "slack.send_message",
    config: { channel: "#payments", text: "Payment received!" },
    position: { x: 200, y: 0 },
    ...overrides,
  };
}

describe("validateGraph", () => {
  it("passes for a valid trigger + action graph connected by one edge", () => {
    const graph: WorkflowGraph = {
      nodes: [trigger(), action()],
      edges: [{ id: "e1", source: "trigger1", target: "action1" }],
    };

    const result = validateGraph(graph, CATALOG);

    expect(result.valid).toBe(true);
  });

  it("passes for an empty graph (documented: no nodes means no trigger-count violation)", () => {
    const result = validateGraph({ nodes: [], edges: [] }, CATALOG);

    expect(result.valid).toBe(true);
  });

  it("reports UNKNOWN_NODE_TYPE for a node whose type is not in the catalog", () => {
    const graph: WorkflowGraph = {
      nodes: [trigger(), action({ id: "action1", type: "does.not.exist" })],
      edges: [{ id: "e1", source: "trigger1", target: "action1" }],
    };

    const result = validateGraph(graph, CATALOG);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "UNKNOWN_NODE_TYPE", nodeId: "action1" }),
      );
    }
  });

  it("reports INVALID_CONFIG when a node's config fails its JSON Schema", () => {
    const graph: WorkflowGraph = {
      nodes: [trigger(), action({ config: { channel: "#payments" } })], // missing required "text"
      edges: [{ id: "e1", source: "trigger1", target: "action1" }],
    };

    const result = validateGraph(graph, CATALOG);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "INVALID_CONFIG", nodeId: "action1" }),
      );
    }
  });

  it("reports TRIGGER_COUNT for a graph with two trigger nodes", () => {
    const graph: WorkflowGraph = {
      nodes: [trigger({ id: "trigger1" }), trigger({ id: "trigger2" })],
      edges: [],
    };

    const result = validateGraph(graph, CATALOG);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "TRIGGER_COUNT" }));
    }
  });

  it("reports CYCLE_DETECTED for a graph containing a cycle", () => {
    const graph: WorkflowGraph = {
      nodes: [
        trigger({ id: "trigger1" }),
        action({ id: "a1" }),
        action({ id: "a2" }),
      ],
      edges: [
        { id: "e1", source: "trigger1", target: "a1" },
        { id: "e2", source: "a1", target: "a2" },
        { id: "e3", source: "a2", target: "a1" }, // a1 <-> a2 cycle
      ],
    };

    const result = validateGraph(graph, CATALOG);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "CYCLE_DETECTED" }));
    }
  });

  it("reports DANGLING_EDGE when an edge references a nonexistent node", () => {
    const graph: WorkflowGraph = {
      nodes: [trigger()],
      edges: [{ id: "e1", source: "trigger1", target: "ghost" }],
    };

    const result = validateGraph(graph, CATALOG);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "DANGLING_EDGE", edgeId: "e1" }),
      );
    }
  });

  it("reports ORPHAN_NODE for an action node unreachable from the trigger", () => {
    const graph: WorkflowGraph = {
      nodes: [trigger(), action({ id: "action1" }), action({ id: "orphan1" })],
      edges: [{ id: "e1", source: "trigger1", target: "action1" }],
    };

    const result = validateGraph(graph, CATALOG);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "ORPHAN_NODE", nodeId: "orphan1" }),
      );
    }
  });

  it("reports TRIGGER_HAS_INBOUND when a trigger node is an edge target", () => {
    const graph: WorkflowGraph = {
      nodes: [trigger(), action()],
      edges: [
        { id: "e1", source: "trigger1", target: "action1" },
        { id: "e2", source: "action1", target: "trigger1" },
      ],
    };

    const result = validateGraph(graph, CATALOG);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "TRIGGER_HAS_INBOUND", nodeId: "trigger1" }),
      );
    }
  });

  it("collects multiple errors from a single call instead of short-circuiting", () => {
    const graph: WorkflowGraph = {
      nodes: [
        trigger({ id: "trigger1" }),
        trigger({ id: "trigger2" }), // TRIGGER_COUNT
        action({ id: "action1", type: "does.not.exist" }), // UNKNOWN_NODE_TYPE
      ],
      edges: [{ id: "e1", source: "trigger1", target: "ghost" }], // DANGLING_EDGE
    };

    const result = validateGraph(graph, CATALOG);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("TRIGGER_COUNT");
      expect(codes).toContain("UNKNOWN_NODE_TYPE");
      expect(codes).toContain("DANGLING_EDGE");
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});
