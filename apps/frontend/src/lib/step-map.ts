// Pure reducer: ordered SseEvent[] -> activity timeline rows. No React, no
// I/O — this is what makes replay and reconnect trivial (section 3 of
// Plans/03-frontend.md: "rendering is a pure function of the ordered event
// list"). Kept separate from run-store so it's independently unit-testable.
import type { AgentStepKind, SseEvent, ValidationError } from "@zoft/contract";

export type StepStatus = "running" | "done" | "error";
export type TimelineRowKind = AgentStepKind | "validation_error" | "retry" | "provider_switch";

export interface TimelineRow {
  key: string;
  kind: TimelineRowKind;
  label: string;
  status: StepStatus;
  seq: number;
  toolInput?: unknown;
  toolResult?: unknown;
  toolError?: string;
  validationErrors?: ValidationError[];
  /** Approximate elapsed time in ms, derived from client receive timestamps (the contract carries no server timestamp). */
  timingMs?: number;
}

/**
 * Reduces a run's event list into timeline rows. `receivedAt` maps seq -> client
 * receive time (ms since epoch), used only to approximate per-row timing.
 * `runTerminal`/`runFailed` let the last row settle to "done"/"error" once the
 * run has ended, since some steps (e.g. a bare "validating" step) never get an
 * explicit closing event of their own.
 */
export function buildTimeline(
  events: SseEvent[],
  receivedAt: Record<number, number>,
  runTerminal: boolean,
  runFailed: boolean,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const callToRowKey = new Map<string, string>();

  for (const evt of events) {
    switch (evt.event) {
      case "agent.step": {
        rows.push({
          key: `step-${evt.seq}`,
          kind: evt.data.kind,
          label: evt.data.label,
          status: "running",
          seq: evt.seq,
        });
        break;
      }
      case "tool.call": {
        const target = rows[rows.length - 1];
        if (target) {
          target.toolInput = evt.data.input;
          callToRowKey.set(evt.data.callId, target.key);
        }
        break;
      }
      case "tool.result": {
        const rowKey = callToRowKey.get(evt.data.callId);
        const target = rowKey ? rows.find((r) => r.key === rowKey) : rows[rows.length - 1];
        if (target) {
          target.toolResult = evt.data.result;
          const start = receivedAt[target.seq];
          const end = receivedAt[evt.seq];
          if (start !== undefined && end !== undefined) target.timingMs = end - start;
          if (!evt.data.ok) {
            target.status = "error";
            if (evt.data.error !== undefined) target.toolError = evt.data.error;
          }
        }
        break;
      }
      case "validation.error": {
        rows.push({
          key: `verr-${evt.seq}`,
          kind: "validation_error",
          label: "Validation found problems",
          status: "error",
          seq: evt.seq,
          validationErrors: evt.data.errors,
        });
        break;
      }
      case "retry": {
        rows.push({
          key: `retry-${evt.seq}`,
          kind: "retry",
          label: `Retrying (attempt ${evt.data.attempt} of ${evt.data.max})`,
          status: "running",
          seq: evt.seq,
        });
        break;
      }
      case "provider.switched": {
        rows.push({
          key: `prov-${evt.seq}`,
          kind: "provider_switch",
          label: `Switched AI provider: ${evt.data.from} → ${evt.data.to}`,
          status: "done",
          seq: evt.seq,
        });
        break;
      }
      default:
        break;
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const next = rows[i + 1];
    if (row.timingMs === undefined && next) {
      const start = receivedAt[row.seq];
      const end = receivedAt[next.seq];
      if (start !== undefined && end !== undefined) row.timingMs = end - start;
    }
    if (row.status === "error") continue;
    if (next) {
      row.status = "done";
    } else if (runTerminal) {
      row.status = runFailed ? "error" : "done";
    }
  }

  return rows;
}
