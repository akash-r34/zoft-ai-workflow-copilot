// Graph diffing, ported from apps/frontend/mock/graph-ops.ts so the real
// backend's /diff endpoint and workflow.proposed/workflow.updated SSE
// payloads match the mock's diff shape byte-for-byte (the frontend's
// DiffView renders this WorkflowDiff regardless of which backend produced it).
import type { WorkflowDiff, WorkflowDiffDto, WorkflowGraph } from "@zoft/contract";

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
