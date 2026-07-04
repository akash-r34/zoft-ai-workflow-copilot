// Live run state (Zustand) — explicitly separate from TanStack Query's
// cached server state. This is the ordered, replayable event log for the
// in-flight run: rendering (chat prose, timeline, workflow diff) is a pure
// function of `events`, reduced by `seq`. Nothing here survives a page
// refresh, and nothing here is fetched — it only grows as SSE frames arrive.
import { create } from "zustand";
import type { SseEvent } from "@zoft/contract";
import type { ConnectionStatus } from "../lib/sse";

export type RunOutcome = "running" | "completed" | "failed" | "cancelled" | "timed_out" | null;

interface RunState {
  runId: string | null;
  /** The conversation the active run belongs to — lets a multi-session UI avoid
   *  leaking one conversation's live run turn into another when the user switches. */
  conversationId: string | null;
  events: SseEvent[];
  /** Client receive time per seq — used only to approximate step timing in the timeline. */
  receivedAt: Record<number, number>;
  connectionStatus: ConnectionStatus;
  outcome: RunOutcome;
  startRun: (runId: string, conversationId: string) => void;
  addEvent: (evt: SseEvent) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  reset: () => void;
}

function outcomeFor(evt: SseEvent, current: RunOutcome): RunOutcome {
  switch (evt.event) {
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    case "run.timeout":
      return "timed_out";
    default:
      return current;
  }
}

export const useRunStore = create<RunState>((set, get) => ({
  runId: null,
  conversationId: null,
  events: [],
  receivedAt: {},
  connectionStatus: "connecting",
  outcome: null,

  startRun: (runId, conversationId) =>
    set({
      runId,
      conversationId,
      events: [],
      receivedAt: {},
      connectionStatus: "connecting",
      outcome: "running",
    }),

  addEvent: (evt) => {
    const { events, receivedAt } = get();
    if (events.some((e) => e.seq === evt.seq)) return; // dedupe replayed events on reconnect
    const next = [...events, evt].sort((a, b) => a.seq - b.seq);
    set({
      events: next,
      receivedAt: { ...receivedAt, [evt.seq]: Date.now() },
      outcome: outcomeFor(evt, get().outcome),
    });
  },

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

  reset: () =>
    set({
      runId: null,
      conversationId: null,
      events: [],
      receivedAt: {},
      connectionStatus: "connecting",
      outcome: null,
    }),
}));

// ── Pure selectors over an event list (kept free of store internals so they're easy to unit test) ──
export function selectStreamedText(events: SseEvent[]): string {
  return events
    .filter((e): e is Extract<SseEvent, { event: "token" }> => e.event === "token")
    .map((e) => e.data.text)
    .join("");
}

export function selectLatestWorkflowUpdate(
  events: SseEvent[],
): Extract<SseEvent, { event: "workflow.updated" }>["data"] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt?.event === "workflow.updated") return evt.data;
  }
  return undefined;
}

export function selectIsTerminal(outcome: RunOutcome): boolean {
  return outcome !== null && outcome !== "running";
}

/**
 * PRD v1.1 Decision #1 — the mandatory human approval gate. Returns the
 * latest workflow.proposed payload IF it hasn't already been superseded by a
 * workflow.updated (i.e. approved) event with a later seq. Once the run
 * reaches ANY terminal outcome (approved -> workflow.updated + run.completed,
 * or rejected -> run.completed with no workflow.updated), the caller should
 * additionally check `selectIsTerminal(outcome)` and stop rendering this —
 * kept as a separate check rather than folded in here so this stays a pure
 * function of `events` alone, consistent with every other selector in this file.
 */
export function selectPendingProposal(
  events: SseEvent[],
): Extract<SseEvent, { event: "workflow.proposed" }>["data"] | undefined {
  let proposed: Extract<SseEvent, { event: "workflow.proposed" }>["data"] | undefined;
  let proposedSeq = -1;
  let updatedSeq = -1;
  for (const evt of events) {
    if (evt.event === "workflow.proposed") {
      proposed = evt.data;
      proposedSeq = evt.seq;
    } else if (evt.event === "workflow.updated") {
      updatedSeq = evt.seq;
    }
  }
  return proposed && proposedSeq > updatedSeq ? proposed : undefined;
}

type TerminalEvent = Extract<SseEvent, { event: "run.failed" | "run.timeout" | "run.cancelled" }>;

export function selectTerminalFailureEvent(events: SseEvent[]): TerminalEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (
      evt?.event === "run.failed" ||
      evt?.event === "run.timeout" ||
      evt?.event === "run.cancelled"
    ) {
      return evt as TerminalEvent;
    }
  }
  return undefined;
}
