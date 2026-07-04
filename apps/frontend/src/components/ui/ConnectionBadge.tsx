"use client";

import { WifiOff } from "lucide-react";
import { useRunStore } from "../../stores/run-store";

// Absence of a heartbeat flips connectionStatus to "reconnecting" (lib/sse.ts's
// watchdog) — surfaced here as a transient badge so the user sees the
// EventSource is auto-recovering rather than assuming the run stalled.
export function ConnectionBadge() {
  const status = useRunStore((s) => s.connectionStatus);
  const runId = useRunStore((s) => s.runId);
  const outcome = useRunStore((s) => s.outcome);

  if (!runId || outcome !== "running" || status !== "reconnecting") return null;

  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning">
      <WifiOff className="h-3 w-3" />
      Reconnecting…
    </span>
  );
}
