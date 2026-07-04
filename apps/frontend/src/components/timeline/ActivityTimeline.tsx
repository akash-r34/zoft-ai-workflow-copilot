import type { TimelineRow } from "../../lib/step-map";
import { TimelineStep } from "./TimelineStep";

export function ActivityTimeline({ rows }: { rows: TimelineRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <TimelineStep key={row.key} row={row} />
      ))}
    </div>
  );
}
