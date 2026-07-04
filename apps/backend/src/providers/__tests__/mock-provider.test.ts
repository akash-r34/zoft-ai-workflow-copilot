import { describe, expect, it } from "vitest";
import type { NodeDefinitionDto, Operation, WorkflowGraph } from "@zoft/contract";
import { MockProvider } from "../mock-provider.js";
import type { ProviderDelta, TurnContext } from "../types.js";

const CATALOG: NodeDefinitionDto[] = [
  {
    type: "stripe.payment_received",
    category: "trigger",
    displayName: "Stripe: Payment Received",
    description: "Fires when Stripe receives a payment.",
    provider: "stripe",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    inputs: [],
    outputs: [{ name: "payment", type: "stripe.Payment" }],
  },
  {
    type: "slack.send_message",
    category: "action",
    displayName: "Slack: Send Message",
    description: "Sends a message to a Slack channel.",
    provider: "slack",
    configSchema: {
      type: "object",
      required: ["channel", "text"],
      properties: { channel: { type: "string" }, text: { type: "string" } },
      additionalProperties: false,
    },
    inputs: [{ name: "trigger", type: "any" }],
    outputs: [],
  },
  {
    type: "teams.send_message",
    category: "action",
    displayName: "Teams: Send Message",
    description: "Sends a message to a Microsoft Teams channel.",
    provider: "teams",
    configSchema: {
      type: "object",
      required: ["teamId", "channelId", "text"],
      properties: { teamId: { type: "string" }, channelId: { type: "string" }, text: { type: "string" } },
      additionalProperties: false,
    },
    inputs: [{ name: "trigger", type: "any" }],
    outputs: [],
  },
  {
    type: "filter.condition",
    category: "action",
    displayName: "Filter: Condition",
    description: "Passes through only when a field satisfies a condition.",
    provider: "filter",
    configSchema: {
      type: "object",
      required: ["field", "op", "value"],
      properties: { field: { type: "string" }, op: { type: "string" }, value: {} },
      additionalProperties: false,
    },
    inputs: [{ name: "value", type: "any" }],
    outputs: [{ name: "passed", type: "any" }],
  },
];

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };

function baseCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    userMessage: "",
    currentGraph: EMPTY_GRAPH,
    catalog: CATALOG,
    attempt: 1,
    ...overrides,
  };
}

/** Drains a provider turn to completion (bounded, so a bug that never yields "finish" fails the test instead of hanging it). */
async function collectDeltas(iter: AsyncIterable<ProviderDelta>, cap = 50): Promise<ProviderDelta[]> {
  const out: ProviderDelta[] = [];
  for await (const delta of iter) {
    out.push(delta);
    if (delta.type === "finish" || out.length >= cap) break;
  }
  return out;
}

function toolUses(deltas: ProviderDelta[]): Extract<ProviderDelta, { type: "tool_use" }>[] {
  return deltas.filter((d): d is Extract<ProviderDelta, { type: "tool_use" }> => d.type === "tool_use");
}

describe("MockProvider — build scenario", () => {
  it("creates a Stripe -> Slack workflow from scratch", async () => {
    const provider = new MockProvider();
    const ctx = baseCtx({ userMessage: "send a slack message whenever stripe receives a payment" });
    const deltas = await collectDeltas(provider.run(ctx));

    const calls = toolUses(deltas);
    expect(calls.map((c) => c.tool)).toEqual(["search_nodes", "get_node_schema", "propose_operations"]);

    const proposeInput = calls[2]?.input as { ops: Operation[]; summary: string };
    expect(proposeInput.ops).toHaveLength(3); // add trigger, add action, add edge
    expect(proposeInput.ops[0]).toMatchObject({ op: "add_node", node: { type: "stripe.payment_received" } });
    expect(proposeInput.ops[1]).toMatchObject({ op: "add_node", node: { type: "slack.send_message" } });
    expect(proposeInput.ops[2]?.op).toBe("add_edge");
    expect(proposeInput.summary).toContain("Slack");
    expect(deltas.at(-1)).toEqual({ type: "finish", reason: "tool_use" });
  });

  it("creates a Stripe -> Teams workflow when only Teams is mentioned", async () => {
    const provider = new MockProvider();
    const ctx = baseCtx({ userMessage: "send a teams message whenever stripe receives a payment" });
    const deltas = await collectDeltas(provider.run(ctx));
    const proposeInput = toolUses(deltas)[2]?.input as { ops: Operation[] };
    expect(proposeInput.ops[1]).toMatchObject({ op: "add_node", node: { type: "teams.send_message" } });
  });

  it("replaces Slack with Teams via replace_node when a workflow already exists", async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
        { id: "a1", type: "slack.send_message", config: { channel: "#x", text: "hi" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const provider = new MockProvider();
    const ctx = baseCtx({ userMessage: "replace slack with microsoft teams", currentGraph: graph });
    const deltas = await collectDeltas(provider.run(ctx));
    const proposeInput = toolUses(deltas).find((c) => c.tool === "propose_operations")?.input as {
      ops: Operation[];
    };
    expect(proposeInput.ops).toEqual([
      {
        op: "replace_node",
        nodeId: "a1",
        newType: "teams.send_message",
        config: { teamId: "team-1", channelId: "channel-1", text: "Payment received" },
      },
    ]);
  });

  it("adds a threshold filter after the trigger, rewiring the existing edge", async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
        { id: "a1", type: "slack.send_message", config: { channel: "#x", text: "hi" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const provider = new MockProvider();
    const ctx = baseCtx({ userMessage: "only notify for payments above $500", currentGraph: graph });
    const deltas = await collectDeltas(provider.run(ctx));
    const proposeInput = toolUses(deltas).find((c) => c.tool === "propose_operations")?.input as {
      ops: Operation[];
    };

    const addNode = proposeInput.ops.find((o) => o.op === "add_node");
    expect(addNode).toMatchObject({ op: "add_node", node: { type: "filter.condition", config: { value: 500 } } });
    // The original trigger->action edge must be removed and rerouted through the new filter node.
    expect(proposeInput.ops.some((o) => o.op === "remove_edge" && o.edgeId === "e1")).toBe(true);
    expect(proposeInput.ops.filter((o) => o.op === "add_edge")).toHaveLength(2);
  });

  it("returns null-mutation text when the message doesn't map to any known change", async () => {
    const provider = new MockProvider();
    const ctx = baseCtx({ userMessage: "do something incomprehensible" });
    const deltas = await collectDeltas(provider.run(ctx));
    expect(toolUses(deltas).map((c) => c.tool)).toEqual(["search_nodes"]);
    expect(deltas.some((d) => d.type === "text")).toBe(true);
  });
});

describe("MockProvider — explain scenario", () => {
  it("summarizes the current workflow's steps", async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
        { id: "a1", type: "slack.send_message", config: { channel: "#x", text: "hi" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const provider = new MockProvider();
    const deltas = await collectDeltas(
      provider.run(baseCtx({ userMessage: "explain this workflow", currentGraph: graph })),
    );
    const text = deltas.filter((d): d is Extract<ProviderDelta, { type: "text" }> => d.type === "text");
    expect(text[0]?.text).toContain("Stripe: Payment Received");
    expect(text[0]?.text).toContain("Slack: Send Message");
  });

  it("answers 'why' using lastChangeSummary when this isn't the first version", async () => {
    const provider = new MockProvider();
    const graph: WorkflowGraph = {
      nodes: [{ id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
    };
    const deltas = await collectDeltas(
      provider.run(
        baseCtx({
          userMessage: "why did you make that change",
          currentGraph: graph,
          isFirstVersion: false,
          lastChangeSummary: "Added a threshold filter",
        }),
      ),
    );
    const text = deltas.find((d): d is Extract<ProviderDelta, { type: "text" }> => d.type === "text");
    expect(text?.text).toContain("Added a threshold filter");
  });

  it("handles an empty workflow gracefully", async () => {
    const provider = new MockProvider();
    const deltas = await collectDeltas(provider.run(baseCtx({ userMessage: "explain this workflow" })));
    const text = deltas.find((d): d is Extract<ProviderDelta, { type: "text" }> => d.type === "text");
    expect(text?.text).toMatch(/no workflow yet/i);
  });
});

describe("MockProvider — self-correction scenario", () => {
  it("proposes an invalid config on attempt 1 and a valid one on attempt 2", async () => {
    const provider = new MockProvider();
    const attempt1 = await collectDeltas(
      provider.run(baseCtx({ userMessage: "create a bad slack workflow for stripe", attempt: 1 })),
    );
    const propose1 = toolUses(attempt1).find((c) => c.tool === "propose_operations")?.input as {
      ops: Operation[];
    };
    const slackNode = propose1.ops.find(
      (o) => o.op === "add_node" && o.node.type === "slack.send_message",
    );
    expect(slackNode).toBeDefined();
    if (slackNode?.op === "add_node") {
      expect(slackNode.node.config).not.toHaveProperty("channel"); // deliberately missing required field
    }

    const attempt2 = await collectDeltas(
      provider.run(baseCtx({ userMessage: "create a bad slack workflow for stripe", attempt: 2 })),
    );
    const propose2 = toolUses(attempt2).find((c) => c.tool === "propose_operations")?.input as {
      ops: Operation[];
    };
    const repairedSlackNode = propose2.ops.find(
      (o) => o.op === "add_node" && o.node.type === "slack.send_message",
    );
    if (repairedSlackNode?.op === "add_node") {
      expect(repairedSlackNode.node.config).toHaveProperty("channel");
    }
  });
});

describe("MockProvider — fail scenario", () => {
  it("always proposes a hallucinated node type, regardless of attempt", async () => {
    const provider = new MockProvider();
    for (const attempt of [1, 2, 3]) {
      const deltas = await collectDeltas(provider.run(baseCtx({ userMessage: "please fail to build this", attempt })));
      const propose = toolUses(deltas).find((c) => c.tool === "propose_operations")?.input as {
        ops: Operation[];
      };
      const bogus = propose.ops.find((o) => o.op === "add_node");
      expect(bogus).toMatchObject({ op: "add_node", node: { type: "totally.unknown.node_type" } });
    }
  });
});

describe("MockProvider — provider-switch scenario", () => {
  it("emits a provider_switch delta before continuing with a normal build", async () => {
    const provider = new MockProvider();
    const deltas = await collectDeltas(
      provider.run(baseCtx({ userMessage: "use the provider to send a slack message for stripe" })),
    );
    expect(deltas[0]).toMatchObject({ type: "provider_switch", from: "anthropic", to: "mock" });
    expect(toolUses(deltas).some((c) => c.tool === "propose_operations")).toBe(true);
  });
});

describe("MockProvider — tool-failure scenario", () => {
  it("fails the first search_nodes call and succeeds on retry", async () => {
    const provider = new MockProvider();
    const deltas = await collectDeltas(
      provider.run(baseCtx({ userMessage: "use a tool to send a slack message for stripe" })),
    );
    const searches = toolUses(deltas).filter((c) => c.tool === "search_nodes");
    expect(searches).toHaveLength(2);
    expect(searches[0]?.input).toMatchObject({ _simulateFailure: true });
    expect(searches[1]?.input).not.toHaveProperty("_simulateFailure");
  });
});

describe("MockProvider — timeout scenario", () => {
  it("yields at least one tool call and then never resolves further (the orchestrator's deadline is what ends it)", async () => {
    const provider = new MockProvider();
    const iterator = provider.run(baseCtx({ userMessage: "this will timeout building the workflow" }))[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "tool_use", tool: "search_nodes" });

    // Race the next delta against a short timer — it must NOT resolve, proving
    // the scenario genuinely hangs rather than completing quickly.
    const race = await Promise.race([
      iterator.next().then(() => "resolved" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 200)),
    ]);
    expect(race).toBe("timed-out");
  });
});
