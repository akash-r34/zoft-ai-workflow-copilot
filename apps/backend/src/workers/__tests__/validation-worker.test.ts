import { describe, expect, it } from "vitest";
import type { CatalogEntry, WorkflowGraph } from "../../core/types.js";
import { collectFindings, summarize } from "../validation-worker.js";

const CATALOG: CatalogEntry[] = [
  {
    type: "stripe.payment_received",
    category: "trigger",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    inputs: [],
    outputs: [{ name: "payment", type: "stripe.Payment" }],
  },
  {
    type: "slack.send_message",
    category: "action",
    configSchema: {
      type: "object",
      required: ["channel", "text"],
      properties: { channel: { type: "string" }, text: { type: "string" } },
      additionalProperties: false,
    },
    inputs: [{ name: "trigger", type: "any" }],
    outputs: [],
  },
];

const VALID_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
    {
      id: "a1",
      type: "slack.send_message",
      config: { channel: "#payments", text: "hi" },
      position: { x: 200, y: 0 },
    },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
};

describe("collectFindings", () => {
  it("finds nothing when every workflow's graph still validates against the catalog", () => {
    const findings = collectFindings([{ id: "wf-1", graph: VALID_GRAPH }], CATALOG);
    expect(findings).toEqual([]);
  });

  it("reports a workflow whose node type no longer exists in the catalog", () => {
    const shrunkCatalog = CATALOG.filter((c) => c.type !== "slack.send_message");
    const findings = collectFindings([{ id: "wf-1", graph: VALID_GRAPH }], shrunkCatalog);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ workflowId: "wf-1" });
    expect(findings[0]?.errorCodes).toContain("UNKNOWN_NODE_TYPE");
  });

  it("reports a workflow whose config no longer satisfies a tightened schema", () => {
    const tightenedCatalog: CatalogEntry[] = CATALOG.map((c) =>
      c.type === "slack.send_message"
        ? {
            ...c,
            configSchema: {
              type: "object",
              required: ["channel", "text", "iconEmoji"], // newly required field the existing graph lacks
              properties: {
                channel: { type: "string" },
                text: { type: "string" },
                iconEmoji: { type: "string" },
              },
              additionalProperties: false,
            },
          }
        : c,
    );
    const findings = collectFindings([{ id: "wf-1", graph: VALID_GRAPH }], tightenedCatalog);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.errorCodes).toContain("INVALID_CONFIG");
  });

  it("checks each workflow independently — one bad graph doesn't hide a good one", () => {
    const shrunkCatalog = CATALOG.filter((c) => c.type !== "slack.send_message");
    const emptyGraph: WorkflowGraph = { nodes: [], edges: [] };
    const findings = collectFindings(
      [
        { id: "wf-bad", graph: VALID_GRAPH },
        { id: "wf-empty-is-fine", graph: emptyGraph },
      ],
      shrunkCatalog,
    );
    expect(findings.map((f) => f.workflowId)).toEqual(["wf-bad"]);
  });
});

describe("summarize", () => {
  it("returns undefined for a clean sweep", () => {
    expect(summarize([])).toBeUndefined();
  });

  it("renders a human-readable summary of findings", () => {
    const summary = summarize([{ workflowId: "wf-1", errorCodes: ["UNKNOWN_NODE_TYPE"] }]);
    expect(summary).toContain("wf-1");
    expect(summary).toContain("UNKNOWN_NODE_TYPE");
    expect(summary).toMatch(/^Found 1 workflow/);
  });
});
