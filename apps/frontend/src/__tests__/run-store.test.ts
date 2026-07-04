import { beforeEach, describe, expect, it } from "vitest";
import type { SseEvent, WorkflowGraph } from "@zoft/contract";
import {
  selectPendingProposal,
  selectStreamedText,
  selectTerminalFailureEvent,
  useRunStore,
} from "../stores/run-store";

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };
const EMPTY_DIFF = { added: { nodes: [], edges: [] }, removed: { nodes: [], edges: [] }, changed: [] };

describe("run-store", () => {
  beforeEach(() => {
    useRunStore.getState().reset();
  });

  it("starts a run scoped to a conversation, with a clean event log", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    const state = useRunStore.getState();
    expect(state.runId).toBe("run-1");
    expect(state.conversationId).toBe("conv-1");
    expect(state.events).toEqual([]);
    expect(state.outcome).toBe("running");
  });

  it("orders events by seq regardless of arrival order", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    const { addEvent } = useRunStore.getState();
    addEvent({ event: "agent.step", seq: 3, data: { kind: "planning", label: "c" } });
    addEvent({ event: "agent.step", seq: 1, data: { kind: "planning", label: "a" } });
    addEvent({ event: "agent.step", seq: 2, data: { kind: "planning", label: "b" } });
    expect(useRunStore.getState().events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("dedupes an event replayed at the same seq (reconnect replay)", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    const { addEvent } = useRunStore.getState();
    const replayed: SseEvent = { event: "run.started", seq: 1, data: { runId: "run-1" } };
    addEvent(replayed);
    addEvent(replayed);
    expect(useRunStore.getState().events).toHaveLength(1);
  });

  it("accumulates streamed token text in seq order", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    const { addEvent } = useRunStore.getState();
    addEvent({ event: "token", seq: 2, data: { text: " world" } });
    addEvent({ event: "token", seq: 1, data: { text: "Hello" } });
    expect(selectStreamedText(useRunStore.getState().events)).toBe("Hello world");
  });

  it("transitions outcome to completed on run.completed", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    useRunStore.getState().addEvent({ event: "run.completed", seq: 1, data: { runId: "run-1" } });
    expect(useRunStore.getState().outcome).toBe("completed");
  });

  it("transitions outcome to failed on run.failed", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    useRunStore.getState().addEvent({
      event: "run.failed",
      seq: 1,
      data: { runId: "run-1", error: { code: "VALIDATION_FAILED", message: "bad" } },
    });
    expect(useRunStore.getState().outcome).toBe("failed");
  });

  it("transitions outcome to cancelled on run.cancelled", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    useRunStore.getState().addEvent({ event: "run.cancelled", seq: 1, data: { runId: "run-1" } });
    expect(useRunStore.getState().outcome).toBe("cancelled");
  });

  it("transitions outcome to timed_out on run.timeout", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    useRunStore.getState().addEvent({
      event: "run.timeout",
      seq: 1,
      data: { runId: "run-1", draftAvailable: true },
    });
    expect(useRunStore.getState().outcome).toBe("timed_out");
  });

  it("a heartbeat (or any other in-flight event) leaves outcome unchanged", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    useRunStore
      .getState()
      .addEvent({ event: "agent.step", seq: 1, data: { kind: "planning", label: "..." } });
    expect(useRunStore.getState().outcome).toBe("running");
  });

  it("selectTerminalFailureEvent returns the most recent failure-shaped terminal event", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    const { addEvent } = useRunStore.getState();
    addEvent({ event: "run.started", seq: 1, data: { runId: "run-1" } });
    addEvent({ event: "run.timeout", seq: 2, data: { runId: "run-1", draftAvailable: true } });
    const terminal = selectTerminalFailureEvent(useRunStore.getState().events);
    expect(terminal?.event).toBe("run.timeout");
  });

  it("selectTerminalFailureEvent returns undefined for a successful run", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    useRunStore.getState().addEvent({ event: "run.completed", seq: 1, data: { runId: "run-1" } });
    expect(selectTerminalFailureEvent(useRunStore.getState().events)).toBeUndefined();
  });

  it("selectPendingProposal surfaces a workflow.proposed event awaiting a decision", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    const { addEvent } = useRunStore.getState();
    addEvent({ event: "run.started", seq: 1, data: { runId: "run-1" } });
    addEvent({
      event: "workflow.proposed",
      seq: 2,
      data: { workflowId: "wf-1", version: 1, graph: EMPTY_GRAPH, diff: EMPTY_DIFF, summary: "Do the thing" },
    });
    const proposal = selectPendingProposal(useRunStore.getState().events);
    expect(proposal?.summary).toBe("Do the thing");
  });

  it("selectPendingProposal returns undefined once approved (workflow.updated supersedes it)", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    const { addEvent } = useRunStore.getState();
    addEvent({
      event: "workflow.proposed",
      seq: 1,
      data: { workflowId: "wf-1", version: 1, graph: EMPTY_GRAPH, diff: EMPTY_DIFF, summary: "Do the thing" },
    });
    addEvent({
      event: "workflow.updated",
      seq: 2,
      data: { workflowId: "wf-1", version: 1, graph: EMPTY_GRAPH, diff: EMPTY_DIFF },
    });
    expect(selectPendingProposal(useRunStore.getState().events)).toBeUndefined();
  });

  it("selectPendingProposal returns undefined when no proposal has been made", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    useRunStore.getState().addEvent({ event: "run.started", seq: 1, data: { runId: "run-1" } });
    expect(selectPendingProposal(useRunStore.getState().events)).toBeUndefined();
  });

  it("reset clears the run back to its initial, unscoped state", () => {
    useRunStore.getState().startRun("run-1", "conv-1");
    useRunStore.getState().addEvent({ event: "run.completed", seq: 1, data: { runId: "run-1" } });
    useRunStore.getState().reset();
    const state = useRunStore.getState();
    expect(state.runId).toBeNull();
    expect(state.conversationId).toBeNull();
    expect(state.events).toEqual([]);
    expect(state.outcome).toBeNull();
  });
});
