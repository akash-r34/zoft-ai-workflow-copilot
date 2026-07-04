// Small pure helpers for building new WorkflowNode/WorkflowEdge values with
// fresh ids. Used by MockProvider (and, eventually, AnthropicProvider) when
// computing the Operation[] for a proposed change — ported from
// apps/frontend/mock/graph-ops.ts's makeNode/makeEdge.
import { randomUUID } from "node:crypto";
import type { WorkflowEdge, WorkflowNode } from "@zoft/contract";

export function makeNode(type: string, config: Record<string, unknown>): WorkflowNode {
  // Position is a placeholder — the frontend re-lays-out every graph with
  // dagre on render (apps/frontend/src/lib/dagre-layout.ts), so this value is
  // never trusted for display, only carried through as a required field.
  return { id: randomUUID(), type, config, position: { x: 0, y: 0 } };
}

export function makeEdge(source: string, target: string): WorkflowEdge {
  return { id: randomUUID(), source, target };
}
