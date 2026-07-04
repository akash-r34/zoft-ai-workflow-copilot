// Pure WorkflowGraph -> positioned React Flow nodes/edges. Server-supplied
// node.position is deliberately ignored (mock/graph-ops.ts documents the
// same contract) — every render re-lays-out left-to-right with dagre so the
// user never has to drag nodes (03-frontend.md section 6).
import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import { Position, type Edge, type Node } from "@xyflow/react";
import type { WorkflowGraph } from "@zoft/contract";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 76;

export interface NodeMeta {
  label: string;
  provider: string;
}

export type DiffState = "added" | "removed" | "changed";

export interface HighlightSets {
  added: Set<string>;
  removed: Set<string>;
  changed: Set<string>;
}

export const EMPTY_HIGHLIGHT: HighlightSets = {
  added: new Set(),
  removed: new Set(),
  changed: new Set(),
};

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string;
  provider: string;
  config: Record<string, unknown>;
  diffState?: DiffState;
}

export type WorkflowFlowNode = Node<WorkflowNodeData, "workflowNode">;

function opSymbol(op: unknown): string {
  switch (op) {
    case "eq":
      return "=";
    case "neq":
      return "≠";
    case "gt":
      return ">";
    case "gte":
      return "≥";
    case "lt":
      return "<";
    case "lte":
      return "≤";
    default:
      return String(op);
  }
}

/** Conditional edges (filter / schedule nodes) carry a small descriptive label. */
function edgeLabel(nodes: WorkflowGraph["nodes"], sourceId: string): string | undefined {
  const source = nodes.find((n) => n.id === sourceId);
  if (!source) return undefined;
  if (source.type === "filter.condition") {
    const { field, op, value } = source.config;
    if (typeof field === "string") return `${field} ${opSymbol(op)} ${String(value)}`;
  }
  if (source.type === "schedule.weekday_filter") {
    const days = source.config.allowedDays;
    if (Array.isArray(days)) return days.join(", ");
  }
  return undefined;
}

export function layoutGraph(
  graph: WorkflowGraph,
  nodeMeta: (type: string) => NodeMeta,
  highlight: HighlightSets = EMPTY_HIGHLIGHT,
): { nodes: WorkflowFlowNode[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>();
  g.setGraph({ rankdir: "LR", nodesep: 32, ranksep: 64 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of graph.edges) g.setEdge(edge.source, edge.target);

  dagre.layout(g);

  const nodes: WorkflowFlowNode[] = graph.nodes.map((n) => {
    const pos = g.node(n.id);
    const meta = nodeMeta(n.type);
    const diffState: DiffState | undefined = highlight.removed.has(n.id)
      ? "removed"
      : highlight.added.has(n.id)
        ? "added"
        : highlight.changed.has(n.id)
          ? "changed"
          : undefined;

    return {
      id: n.id,
      type: "workflowNode",
      position: { x: (pos?.x ?? 0) - NODE_WIDTH / 2, y: (pos?.y ?? 0) - NODE_HEIGHT / 2 },
      data: {
        label: meta.label,
        provider: meta.provider,
        config: n.config,
        ...(diffState ? { diffState } : {}),
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
    };
  });

  const edges: Edge[] = graph.edges.map((e) => {
    const label = edgeLabel(graph.nodes, e.source);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      style: { stroke: "var(--border)" },
      labelBgStyle: { fill: "var(--bg-elevated)" },
      labelStyle: { fill: "var(--fg-muted)", fontSize: 11 },
      ...(label !== undefined ? { label } : {}),
    };
  });

  return { nodes, edges };
}
