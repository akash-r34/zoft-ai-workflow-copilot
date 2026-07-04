import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@zoft/contract";
import { layoutGraph, type WorkflowFlowNode } from "../lib/dagre-layout";

const graph: WorkflowGraph = {
  nodes: [
    { id: "n1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
    {
      id: "n2",
      type: "slack.send_message",
      config: { channel: "#x", text: "hi" },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [{ id: "e1", source: "n1", target: "n2" }],
};

function meta(type: string): { label: string; provider: string } {
  return { label: type, provider: type.split(".")[0] ?? "" };
}

function findNode(nodes: WorkflowFlowNode[], id: string): WorkflowFlowNode {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`expected node ${id} in layout output`);
  return node;
}

describe("layoutGraph", () => {
  it("produces exactly one positioned React Flow node per graph node", () => {
    const { nodes } = layoutGraph(graph, meta);
    expect(nodes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
  });

  it("lays out left to right: a source node sits left of its target", () => {
    const { nodes } = layoutGraph(graph, meta);
    expect(findNode(nodes, "n1").position.x).toBeLessThan(findNode(nodes, "n2").position.x);
  });

  it("is deterministic for the same input graph", () => {
    const a = layoutGraph(graph, meta);
    const b = layoutGraph(graph, meta);
    expect(a.nodes.map((n) => n.position)).toEqual(b.nodes.map((n) => n.position));
  });

  it("ignores the server-supplied position entirely", () => {
    const shifted: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, position: { x: 9999, y: 9999 } })),
    };
    const { nodes } = layoutGraph(shifted, meta);
    expect(findNode(nodes, "n1").position.x).not.toBe(9999);
  });

  it("marks a node's diffState only when it appears in the corresponding highlight set", () => {
    const { nodes } = layoutGraph(graph, meta, {
      added: new Set(["n2"]),
      removed: new Set(),
      changed: new Set(),
    });
    expect(findNode(nodes, "n2").data.diffState).toBe("added");
    expect(findNode(nodes, "n1").data.diffState).toBeUndefined();
  });

  it("labels a conditional edge sourced from a filter.condition node", () => {
    const withFilter: WorkflowGraph = {
      nodes: [
        ...graph.nodes,
        {
          id: "n3",
          type: "filter.condition",
          config: { field: "amount", op: "gt", value: 500 },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [{ id: "e2", source: "n3", target: "n2" }],
    };
    const { edges } = layoutGraph(withFilter, meta);
    const edge = edges.find((e) => e.id === "e2");
    expect(edge?.label).toBe("amount > 500");
  });

  it("leaves an edge unlabeled when its source isn't a conditional node", () => {
    const { edges } = layoutGraph(graph, meta);
    const edge = edges.find((e) => e.id === "e1");
    expect(edge?.label).toBeUndefined();
  });
});
