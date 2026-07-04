// Pure helpers for building demo graphs and computing diffs. No I/O, no
// framework dependency — reused by both the scenario engine (workflow.updated
// payloads) and the /diff REST endpoint (version-to-version comparisons).
import { randomUUID } from "node:crypto";
import type {
  WorkflowDiff,
  WorkflowDiffDto,
  WorkflowGraph,
  WorkflowNode,
  WorkflowEdge,
} from "@zoft/contract";
import { EMPTY_GRAPH } from "@zoft/contract";

export function makeNode(type: string, config: Record<string, unknown>): WorkflowNode {
  // Position is a placeholder — the frontend re-lays-out every graph with
  // dagre on render, so the server's position value is never trusted for
  // display, only carried through as a required field.
  return { id: randomUUID(), type, config, position: { x: 0, y: 0 } };
}

export function makeEdge(source: string, target: string): WorkflowEdge {
  return { id: randomUUID(), source, target };
}

export function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    nodes: graph.nodes.map((n) => ({ ...n, config: { ...n.config }, position: { ...n.position } })),
    edges: graph.edges.map((e) => ({ ...e })),
  };
}

/** Diff two graphs by node/edge id. Config changes are detected by deep equality. */
export function diffGraphs(before: WorkflowGraph, after: WorkflowGraph): WorkflowDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));

  const addedNodes = after.nodes.filter((n) => !beforeNodes.has(n.id));
  const removedNodes = before.nodes.filter((n) => !afterNodes.has(n.id));
  const addedEdges = after.edges.filter((e) => !beforeEdges.has(e.id));
  const removedEdges = before.edges.filter((e) => !afterEdges.has(e.id));

  const changed: WorkflowDiff["changed"] = [];
  for (const [id, afterNode] of afterNodes) {
    const beforeNode = beforeNodes.get(id);
    if (beforeNode && JSON.stringify(beforeNode.config) !== JSON.stringify(afterNode.config)) {
      changed.push({ id, before: beforeNode, after: afterNode });
    }
  }

  return {
    added: { nodes: addedNodes, edges: addedEdges },
    removed: { nodes: removedNodes, edges: removedEdges },
    changed,
  };
}

export function toWorkflowDiffDto(from: number, to: number, diff: WorkflowDiff): WorkflowDiffDto {
  return { from, to, added: diff.added, removed: diff.removed, changed: diff.changed };
}

export const EMPTY: WorkflowGraph = EMPTY_GRAPH;
