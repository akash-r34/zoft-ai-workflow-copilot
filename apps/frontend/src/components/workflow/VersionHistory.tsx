"use client";

import { useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { useDiff, useRestoreVersion, useVersions } from "../../hooks/useVersions";
import { useRunStore } from "../../stores/run-store";
import { DiffView } from "./DiffView";

export function VersionHistory({ workflowId }: { workflowId: string | null }) {
  const { data: versions } = useVersions(workflowId);
  const restore = useRestoreVersion(workflowId);
  const isRunning = useRunStore((s) => s.outcome === "running");
  const [expanded, setExpanded] = useState<number | null>(null);

  const latest = versions?.[0]?.version ?? null;
  const diff = useDiff(workflowId, expanded, latest);

  if (!versions || versions.length === 0) {
    return <div className="p-4 text-sm text-fg-muted">No versions yet.</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <ul className="space-y-1.5">
        {versions.map((v) => {
          const isCurrent = v.version === latest;
          const isExpanded = expanded === v.version;
          return (
            <li key={v.version} className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setExpanded(isExpanded ? null : v.version)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
              >
                <History className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                <span className="shrink-0 font-mono text-xs text-fg-muted">v{v.version}</span>
                <span className="flex-1 truncate">{v.changeSummary}</span>
                {isCurrent && (
                  <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-fg">
                    current
                  </span>
                )}
              </button>
              {isExpanded && (
                <div className="space-y-2 border-t border-border px-3 py-2">
                  <div className="text-xs text-fg-muted">
                    {v.createdBy === "ai" ? "AI" : "You"} · {new Date(v.createdAt).toLocaleString()}
                  </div>
                  {!isCurrent && diff.data && <DiffView diff={diff.data} />}
                  {!isCurrent && (
                    <button
                      type="button"
                      onClick={() => restore.mutate(v.version)}
                      disabled={restore.isPending || isRunning}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-bg-sunken disabled:opacity-50"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore this version
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
