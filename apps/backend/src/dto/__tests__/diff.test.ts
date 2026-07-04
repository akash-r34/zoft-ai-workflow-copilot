import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@zoft/contract";
import { diffGraphs, toWorkflowDiffDto } from "../diff.js";

const trigger = { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } };
const slack = {
  id: "a1",
  type: "slack.send_message",
  config: { channel: "#payments", text: "hi" },
  position: { x: 200, y: 0 },
};
const teams = {
  id: "a1",
  type: "teams.send_message",
  config: { teamId: "t", channelId: "c", text: "hi" },
  position: { x: 200, y: 0 },
};

describe("diffGraphs", () => {
  it("reports no differences between two identical graphs", () => {
    const graph: WorkflowGraph = { nodes: [trigger], edges: [] };
    const diff = diffGraphs(graph, graph);
    expect(diff.added.nodes).toHaveLength(0);
    expect(diff.removed.nodes).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it("reports newly added nodes and edges", () => {
    const before: WorkflowGraph = { nodes: [trigger], edges: [] };
    const after: WorkflowGraph = {
      nodes: [trigger, slack],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const diff = diffGraphs(before, after);
    expect(diff.added.nodes.map((n) => n.id)).toEqual(["a1"]);
    expect(diff.added.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(diff.removed.nodes).toHaveLength(0);
  });

  it("reports removed nodes and edges", () => {
    const before: WorkflowGraph = {
      nodes: [trigger, slack],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const after: WorkflowGraph = { nodes: [trigger], edges: [] };
    const diff = diffGraphs(before, after);
    expect(diff.removed.nodes.map((n) => n.id)).toEqual(["a1"]);
    expect(diff.removed.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(diff.added.nodes).toHaveLength(0);
  });

  it("reports a node as changed when its config differs but its id is the same (e.g. Slack -> Teams replace_node)", () => {
    const before: WorkflowGraph = { nodes: [trigger, slack], edges: [] };
    const after: WorkflowGraph = { nodes: [trigger, teams], edges: [] };
    const diff = diffGraphs(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.before.type).toBe("slack.send_message");
    expect(diff.changed[0]?.after.type).toBe("teams.send_message");
    expect(diff.added.nodes).toHaveLength(0);
    expect(diff.removed.nodes).toHaveLength(0);
  });

  it("does not report a change when config is deep-equal but a different object reference", () => {
    const before: WorkflowGraph = { nodes: [{ ...slack, config: { channel: "#payments", text: "hi" } }], edges: [] };
    const after: WorkflowGraph = { nodes: [{ ...slack, config: { channel: "#payments", text: "hi" } }], edges: [] };
    expect(diffGraphs(before, after).changed).toHaveLength(0);
  });
});

describe("toWorkflowDiffDto", () => {
  it("carries the from/to version numbers alongside the diff shape", () => {
    const before: WorkflowGraph = { nodes: [], edges: [] };
    const after: WorkflowGraph = { nodes: [trigger], edges: [] };
    const dto = toWorkflowDiffDto(1, 2, diffGraphs(before, after));
    expect(dto.from).toBe(1);
    expect(dto.to).toBe(2);
    expect(dto.added.nodes).toHaveLength(1);
  });
});
