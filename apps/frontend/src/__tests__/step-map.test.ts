import { describe, expect, it } from "vitest";
import type { SseEvent } from "@zoft/contract";
import { buildTimeline } from "../lib/step-map";

describe("buildTimeline", () => {
  it("creates one row per agent.step, marking every row but the last as done", () => {
    const events: SseEvent[] = [
      { event: "agent.step", seq: 1, data: { kind: "planning", label: "Planning..." } },
      { event: "agent.step", seq: 2, data: { kind: "proposing", label: "Proposing..." } },
    ];
    const rows = buildTimeline(events, {}, false, false);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("done");
    expect(rows[1]?.status).toBe("running");
  });

  it("attaches a tool.call/tool.result pair to the preceding agent.step row rather than adding new rows", () => {
    const events: SseEvent[] = [
      { event: "agent.step", seq: 1, data: { kind: "searching_nodes", label: "Searching..." } },
      {
        event: "tool.call",
        seq: 2,
        data: { tool: "search_nodes", input: { query: "slack" }, callId: "c1" },
      },
      {
        event: "tool.result",
        seq: 3,
        data: { callId: "c1", ok: true, result: ["slack.send_message"] },
      },
    ];
    const rows = buildTimeline(events, {}, false, false);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolInput).toEqual({ query: "slack" });
    expect(rows[0]?.toolResult).toEqual(["slack.send_message"]);
  });

  it("marks a row as error when its tool.result is not ok, and carries the error text", () => {
    const events: SseEvent[] = [
      { event: "agent.step", seq: 1, data: { kind: "searching_nodes", label: "Searching..." } },
      { event: "tool.call", seq: 2, data: { tool: "search_nodes", input: {}, callId: "c1" } },
      { event: "tool.result", seq: 3, data: { callId: "c1", ok: false, error: "boom" } },
    ];
    const rows = buildTimeline(events, {}, false, false);
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.toolError).toBe("boom");
  });

  it("gives validation.error its own row carrying the structured errors, not attached to a step", () => {
    const events: SseEvent[] = [
      { event: "agent.step", seq: 1, data: { kind: "validating", label: "Calling validator..." } },
      {
        event: "validation.error",
        seq: 2,
        data: { errors: [{ code: "MISSING_FIELD", message: "channel required", nodeId: "n1" }] },
      },
    ];
    const rows = buildTimeline(events, {}, true, true);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.kind).toBe("validation_error");
    expect(rows[1]?.status).toBe("error");
    expect(rows[1]?.validationErrors).toHaveLength(1);
  });

  it("renders retry and provider.switched as their own rows", () => {
    const events: SseEvent[] = [
      { event: "retry", seq: 1, data: { attempt: 1, max: 3, reason: "validation failed" } },
      {
        event: "provider.switched",
        seq: 2,
        data: { from: "anthropic", to: "mock", reason: "unavailable" },
      },
    ];
    const rows = buildTimeline(events, {}, false, false);
    expect(rows.map((r) => r.kind)).toEqual(["retry", "provider_switch"]);
    expect(rows[0]?.label).toContain("attempt 1 of 3");
  });

  it("settles the last row to done once the run finishes successfully", () => {
    const events: SseEvent[] = [
      { event: "agent.step", seq: 1, data: { kind: "validating", label: "..." } },
    ];
    const rows = buildTimeline(events, {}, true, false);
    expect(rows[0]?.status).toBe("done");
  });

  it("settles the last row to error when the run ultimately fails", () => {
    const events: SseEvent[] = [
      { event: "agent.step", seq: 1, data: { kind: "proposing", label: "..." } },
    ];
    const rows = buildTimeline(events, {}, true, true);
    expect(rows[0]?.status).toBe("error");
  });

  it("leaves the last row running while the run is still in flight", () => {
    const events: SseEvent[] = [
      { event: "agent.step", seq: 1, data: { kind: "proposing", label: "..." } },
    ];
    const rows = buildTimeline(events, {}, false, false);
    expect(rows[0]?.status).toBe("running");
  });

  it("approximates per-row timing from client receive timestamps between consecutive rows", () => {
    const events: SseEvent[] = [
      { event: "agent.step", seq: 1, data: { kind: "planning", label: "..." } },
      { event: "agent.step", seq: 2, data: { kind: "proposing", label: "..." } },
    ];
    const rows = buildTimeline(events, { 1: 1000, 2: 1450 }, false, false);
    expect(rows[0]?.timingMs).toBe(450);
  });

  it("ignores token and workflow.updated events entirely (they don't drive the timeline)", () => {
    const events: SseEvent[] = [
      { event: "token", seq: 1, data: { text: "hi" } },
      {
        event: "workflow.updated",
        seq: 2,
        data: {
          workflowId: "w1",
          version: 1,
          graph: { nodes: [], edges: [] },
          diff: { added: { nodes: [], edges: [] }, removed: { nodes: [], edges: [] }, changed: [] },
        },
      },
    ];
    expect(buildTimeline(events, {}, false, false)).toHaveLength(0);
  });
});
