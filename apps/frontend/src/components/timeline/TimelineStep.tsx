"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import type { TimelineRow } from "../../lib/step-map";
import { STEP_ICONS } from "./step-visuals";

function StatusIcon({ status }: { status: TimelineRow["status"] }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />;
  if (status === "error") return <X className="h-3.5 w-3.5 text-danger" />;
  return <Check className="h-3.5 w-3.5 text-success" />;
}

function formatTiming(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function TimelineStep({ row }: { row: TimelineRow }) {
  const [expanded, setExpanded] = useState(row.status === "error");
  // A step can transition into "error" after it was first rendered running —
  // surface the detail automatically rather than requiring a click to find it.
  useEffect(() => {
    if (row.status === "error") setExpanded(true);
  }, [row.status]);

  const Icon = STEP_ICONS[row.kind];
  const hasDetail =
    row.toolInput !== undefined ||
    row.toolResult !== undefined ||
    row.validationErrors !== undefined ||
    row.toolError !== undefined;

  return (
    <div className="rounded-lg border border-border bg-bg-elevated">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        disabled={!hasDetail}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm disabled:cursor-default"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <span className="flex-1 truncate">{row.label}</span>
        {row.timingMs !== undefined && (
          <span className="shrink-0 text-xs text-fg-muted">{formatTiming(row.timingMs)}</span>
        )}
        <StatusIcon status={row.status} />
        {hasDetail && (
          <ChevronRight
            className={clsx(
              "h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform",
              expanded && "rotate-90",
            )}
          />
        )}
      </button>
      {expanded && hasDetail && (
        <div className="space-y-2 border-t border-border px-3 py-2 text-xs">
          {row.toolInput !== undefined && (
            <div>
              <div className="mb-1 font-medium text-fg-muted">Input</div>
              <pre className="overflow-x-auto rounded bg-bg-sunken p-2">
                {JSON.stringify(row.toolInput, null, 2)}
              </pre>
            </div>
          )}
          {row.toolResult !== undefined && (
            <div>
              <div className="mb-1 font-medium text-fg-muted">Result</div>
              <pre className="overflow-x-auto rounded bg-bg-sunken p-2">
                {JSON.stringify(row.toolResult, null, 2)}
              </pre>
            </div>
          )}
          {row.toolError !== undefined && <div className="text-danger">{row.toolError}</div>}
          {row.validationErrors !== undefined && (
            <ul className="space-y-1">
              {row.validationErrors.map((e, i) => (
                <li key={`${e.code}-${i}`} className="text-danger">
                  <span className="font-mono text-[11px]">{e.code}</span>: {e.message}
                  {e.nodeId !== undefined && (
                    <span className="text-fg-muted"> (node {e.nodeId.slice(0, 8)})</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
