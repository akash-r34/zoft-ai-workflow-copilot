"use client";

import { useState } from "react";
import clsx from "clsx";
import { EMPTY_GRAPH } from "@zoft/contract";
import { useWorkflow } from "../../hooks/useWorkflow";
import { VersionHistory } from "./VersionHistory";
import { WorkflowGraphView } from "./WorkflowGraphView";

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-lg px-2.5 py-1 text-xs font-medium",
        active ? "bg-accent text-accent-fg" : "text-fg-muted hover:bg-bg-sunken",
      )}
    >
      {children}
    </button>
  );
}

export function WorkflowPanel({ workflowId }: { workflowId: string | null }) {
  const { data: workflow } = useWorkflow(workflowId);
  const graph = workflow?.currentVersion?.graph ?? EMPTY_GRAPH;
  const [view, setView] = useState<"graph" | "history">("graph");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <span className="text-sm font-medium">Workflow</span>
        <div className="flex gap-1">
          <TabButton active={view === "graph"} onClick={() => setView("graph")}>
            Graph
          </TabButton>
          <TabButton active={view === "history"} onClick={() => setView("history")}>
            History
          </TabButton>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === "graph" ? (
          <WorkflowGraphView graph={graph} />
        ) : (
          <VersionHistory workflowId={workflowId} />
        )}
      </div>
    </div>
  );
}
