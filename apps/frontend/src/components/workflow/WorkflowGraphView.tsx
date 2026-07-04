"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowGraph, WorkflowNode } from "@zoft/contract";
import { useNodeDefinitions } from "../../hooks/useNodeDefinitions";
import { EMPTY_HIGHLIGHT, layoutGraph, type HighlightSets } from "../../lib/dagre-layout";
import { selectLatestWorkflowUpdate, useRunStore } from "../../stores/run-store";
import { WorkflowNodeCard } from "./WorkflowNodeCard";

const nodeTypes: NodeTypes = { workflowNode: WorkflowNodeCard };

// How long an added/removed/changed node keeps its highlight ring before
// settling to neutral (03-frontend.md section 6: "the diff persists briefly
// ... then settles to neutral").
const HIGHLIGHT_MS = 2600;

// ReactFlow's `fitView` prop only fits once, on mount — it doesn't refit when
// the node set changes later (e.g. a new node inserted upstream of the
// trigger). Refit imperatively whenever the set of visible node ids changes,
// so a growing graph never silently scrolls a node off-screen.
function FitViewOnChange({ nodeIdsKey }: { nodeIdsKey: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    void fitView({ duration: 350, padding: 0.2 });
  }, [nodeIdsKey, fitView]);
  return null;
}

export function WorkflowGraphView({ graph }: { graph: WorkflowGraph }) {
  const { data: catalog } = useNodeDefinitions();
  const events = useRunStore((s) => s.events);
  const diffUpdate = selectLatestWorkflowUpdate(events);

  const [ghostRemoved, setGhostRemoved] = useState<WorkflowNode[]>([]);
  const [highlight, setHighlight] = useState<HighlightSets>(EMPTY_HIGHLIGHT);
  const lastVersionRef = useRef<number | null>(null);

  useEffect(() => {
    if (!diffUpdate || diffUpdate.version === lastVersionRef.current) return;
    lastVersionRef.current = diffUpdate.version;
    setGhostRemoved(diffUpdate.diff.removed.nodes);
    setHighlight({
      added: new Set(diffUpdate.diff.added.nodes.map((n) => n.id)),
      removed: new Set(diffUpdate.diff.removed.nodes.map((n) => n.id)),
      changed: new Set(diffUpdate.diff.changed.map((c) => c.id)),
    });
    const timer = setTimeout(() => {
      setGhostRemoved([]);
      setHighlight(EMPTY_HIGHLIGHT);
    }, HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [diffUpdate]);

  const nodeMeta = useMemo(() => {
    const map = new Map((catalog ?? []).map((n) => [n.type, n]));
    return (type: string) => {
      const entry = map.get(type);
      return { label: entry?.displayName ?? type, provider: entry?.provider ?? "" };
    };
  }, [catalog]);

  const displayGraph = useMemo<WorkflowGraph>(() => {
    const currentIds = new Set(graph.nodes.map((n) => n.id));
    return {
      nodes: [...graph.nodes, ...ghostRemoved.filter((n) => !currentIds.has(n.id))],
      edges: graph.edges,
    };
  }, [graph, ghostRemoved]);

  const { nodes, edges } = useMemo(
    () => layoutGraph(displayGraph, nodeMeta, highlight),
    [displayGraph, nodeMeta, highlight],
  );

  if (displayGraph.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-fg-muted">
        No workflow yet. Describe what you want to automate in the chat.
      </div>
    );
  }

  const nodeIdsKey = nodes
    .map((n) => n.id)
    .sort()
    .join(",");

  return (
    <div className="h-full">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
          <FitViewOnChange nodeIdsKey={nodeIdsKey} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
