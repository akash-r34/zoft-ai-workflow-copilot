import { describe, it, expect } from "vitest";
import { applyOperations } from "../applier.js";
import { EMPTY_GRAPH } from "../types.js";
import type { Operation, WorkflowGraph, WorkflowNode } from "../types.js";

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: "n1",
    type: "slack.send_message",
    config: { channel: "#general", text: "hi" },
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

describe("applyOperations", () => {
  it("adds a node to an empty graph", () => {
    const node = makeNode();
    const ops: Operation[] = [{ op: "add_node", node }];

    const result = applyOperations(EMPTY_GRAPH, ops);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toEqual(node);
    expect(result.edges).toHaveLength(0);
  });

  it("treats remove_node on a missing id as a no-op, without throwing", () => {
    const graph: WorkflowGraph = { nodes: [makeNode()], edges: [] };
    const ops: Operation[] = [{ op: "remove_node", nodeId: "does-not-exist" }];

    expect(() => applyOperations(graph, ops)).not.toThrow();
    const result = applyOperations(graph, ops);
    expect(result).toEqual(graph);
  });

  it("replace_node changes type and config but preserves id and position", () => {
    const node = makeNode({ id: "n1", position: { x: 5, y: 10 } });
    const graph: WorkflowGraph = { nodes: [node], edges: [] };
    const ops: Operation[] = [
      { op: "replace_node", nodeId: "n1", newType: "teams.send_message", config: { teamId: "t1", channelId: "c1", text: "hey" } },
    ];

    const result = applyOperations(graph, ops);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toEqual({
      id: "n1",
      type: "teams.send_message",
      config: { teamId: "t1", channelId: "c1", text: "hey" },
      position: { x: 5, y: 10 },
    });
  });

  it("update_node_config replaces the config object wholesale (documented behavior)", () => {
    const node = makeNode({ config: { channel: "#general", text: "hi" } });
    const graph: WorkflowGraph = { nodes: [node], edges: [] };
    const ops: Operation[] = [{ op: "update_node_config", nodeId: "n1", config: { channel: "#other" } }];

    const result = applyOperations(graph, ops);

    // Replaced wholesale: "text" from the original config is gone, not merged.
    expect(result.nodes[0]?.config).toEqual({ channel: "#other" });
  });

  it("set_node_config_field sets a nested field via dot-notation path", () => {
    const node = makeNode({ config: { channel: "#general", nested: { keep: "me" } } });
    const graph: WorkflowGraph = { nodes: [node], edges: [] };
    const ops: Operation[] = [
      { op: "set_node_config_field", nodeId: "n1", path: "nested.newField", value: 42 },
    ];

    const result = applyOperations(graph, ops);

    expect(result.nodes[0]?.config).toEqual({
      channel: "#general",
      nested: { keep: "me", newField: 42 },
    });
  });

  it("returns a graph equal to the input when applying an empty operation list", () => {
    const graph: WorkflowGraph = {
      nodes: [makeNode()],
      edges: [{ id: "e1", source: "n1", target: "n1" }],
    };

    const result = applyOperations(graph, []);

    expect(result).toEqual(graph);
  });

  it("does not mutate the input graph", () => {
    const original: WorkflowGraph = {
      nodes: [makeNode({ id: "n1" })],
      edges: [{ id: "e1", source: "n1", target: "n1" }],
    };
    const snapshot = structuredClone(original);
    const ops: Operation[] = [
      { op: "add_node", node: makeNode({ id: "n2" }) },
      { op: "update_node_config", nodeId: "n1", config: { channel: "#changed", text: "changed" } },
      { op: "remove_edge", edgeId: "e1" },
    ];

    applyOperations(original, ops);

    expect(original).toEqual(snapshot);
  });
});
