import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import type { WorkflowFlowNode } from "../../lib/dagre-layout";

function summarize(config: Record<string, unknown>): string {
  const entries = Object.entries(config).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return "No configuration";
  return entries
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("/") : String(v)}`)
    .join(" · ");
}

export function WorkflowNodeCard({ data }: NodeProps<WorkflowFlowNode>) {
  return (
    <div
      className={clsx(
        "w-[220px] rounded-xl border bg-bg-elevated px-3 py-2.5 shadow-sm",
        data.diffState === "added" && "animate-diff-add border-success",
        data.diffState === "removed" && "animate-diff-remove border-danger opacity-50",
        data.diffState === "changed" && "animate-diff-change border-warning",
        !data.diffState && "border-border",
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-fg-muted" />
      <div className="truncate text-sm font-medium">{data.label}</div>
      <div className="truncate text-xs text-fg-muted">{data.provider}</div>
      <div className="mt-1 truncate text-[11px] text-fg-muted">{summarize(data.config)}</div>
      <Handle type="source" position={Position.Right} className="!bg-fg-muted" />
    </div>
  );
}
