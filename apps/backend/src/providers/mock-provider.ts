// The default, zero-API-key LlmProvider. Ports the intent of
// apps/frontend/mock/scenarios.ts's keyword-driven "AI" into a real
// LlmProvider: it picks one of seven scripts from the user's message and
// yields ProviderDelta values that DRIVE THE REAL AGENT LOOP — the
// orchestrator executes the resulting tool_use deltas against the real tool
// registry, which runs the real validator (core/validator.ts) before
// anything is proposed. Unlike the mock, this provider never mutates the
// database itself; it only ever proposes.
//
// Scenario selection mirrors mock/scenarios.ts:runScenario exactly, so the
// same demo phrases ("...timeout...", "...fail...", "...provider...",
// "...tool...", "...bad/broken...", "...why/explain...") produce the same
// class of behavior against the real backend.
import { randomUUID } from "node:crypto";
import type { NodeDefinitionDto, Operation, WorkflowGraph, WorkflowNode } from "@zoft/contract";
import { makeEdge, makeNode } from "./graph-helpers.js";
import type { LlmProvider, ProviderDelta, TurnContext } from "./types.js";

function isTrigger(catalog: NodeDefinitionDto[], type: string): boolean {
  return catalog.find((n) => n.type === type)?.category === "trigger";
}

function slackConfig(): Record<string, unknown> {
  return { channel: "#payments", text: "Payment received" };
}

function teamsConfig(): Record<string, unknown> {
  return { teamId: "team-1", channelId: "channel-1", text: "Payment received" };
}

function parseAmount(lower: string): number {
  const match = lower.match(/\$?\s*(\d+(?:\.\d+)?)/);
  return match?.[1] ? Number(match[1]) : 500;
}

interface Mutation {
  ops: Operation[];
  summary: string;
  schemaType: string;
}

/** Rewires the edges leaving `trigger` through `newNode` and inserts it — the Operation-based equivalent of mock/scenarios.ts's insertAfterTrigger, which mutated a full graph directly. */
function insertAfterTriggerOps(
  before: WorkflowGraph,
  trigger: WorkflowNode,
  newNode: WorkflowNode,
): Operation[] {
  const ops: Operation[] = [{ op: "add_node", node: newNode }];
  for (const edge of before.edges) {
    if (edge.source !== trigger.id) continue;
    ops.push({ op: "remove_edge", edgeId: edge.id });
    ops.push({ op: "add_edge", edge: makeEdge(newNode.id, edge.target) });
  }
  ops.push({ op: "add_edge", edge: makeEdge(trigger.id, newNode.id) });
  return ops;
}

/** Keyword-driven graph edit, expressed as Operations rather than a whole new graph. Returns null when the message doesn't map to a known change. */
function computeMutationOps(
  before: WorkflowGraph,
  catalog: NodeDefinitionDto[],
  lower: string,
): Mutation | null {
  const hasStripe = /stripe/.test(lower);
  const hasSlack = /slack/.test(lower);
  const hasTeams = /teams/.test(lower);
  const hasThreshold = /(above|over|greater than|at least|more than)\s*\$?\s*\d+|\$\d+/.test(lower);
  const hasWeekday = /weekday|weekend/.test(lower);

  const existingTrigger = before.nodes.find((n) => isTrigger(catalog, n.type));
  const existingSlack = before.nodes.find((n) => n.type === "slack.send_message");
  const existingTeams = before.nodes.find((n) => n.type === "teams.send_message");
  const existingFilter = before.nodes.find((n) => n.type === "filter.condition");
  const existingWeekday = before.nodes.find((n) => n.type === "schedule.weekday_filter");

  if (hasTeams && existingSlack && !existingTeams) {
    return {
      ops: [
        { op: "replace_node", nodeId: existingSlack.id, newType: "teams.send_message", config: teamsConfig() },
      ],
      summary: "Replaced the Slack step with a Microsoft Teams message.",
      schemaType: "teams.send_message",
    };
  }

  if (hasSlack && existingTeams && !existingSlack) {
    return {
      ops: [
        { op: "replace_node", nodeId: existingTeams.id, newType: "slack.send_message", config: slackConfig() },
      ],
      summary: "Replaced the Teams step with a Slack message.",
      schemaType: "slack.send_message",
    };
  }

  if (!existingTrigger && hasStripe && (hasSlack || hasTeams)) {
    const trigger = makeNode("stripe.payment_received", { currency: "usd" });
    const actionType = hasTeams && !hasSlack ? "teams.send_message" : "slack.send_message";
    const action = makeNode(
      actionType,
      actionType === "teams.send_message" ? teamsConfig() : slackConfig(),
    );
    const label = actionType === "teams.send_message" ? "Microsoft Teams" : "Slack";
    return {
      ops: [
        { op: "add_node", node: trigger },
        { op: "add_node", node: action },
        { op: "add_edge", edge: makeEdge(trigger.id, action.id) },
      ],
      summary: `Created a workflow: Stripe payment received → send a ${label} message.`,
      schemaType: actionType,
    };
  }

  if (hasThreshold && existingTrigger) {
    const amount = parseAmount(lower);
    const config = { field: "amount", op: "gt", value: amount };
    if (existingFilter) {
      return {
        ops: [{ op: "update_node_config", nodeId: existingFilter.id, config }],
        summary: `Updated a condition: only continue when amount > ${amount}.`,
        schemaType: "filter.condition",
      };
    }
    const newNode = makeNode("filter.condition", config);
    return {
      ops: insertAfterTriggerOps(before, existingTrigger, newNode),
      summary: `Added a condition: only continue when amount > ${amount}.`,
      schemaType: "filter.condition",
    };
  }

  if (hasWeekday && existingTrigger) {
    const isWeekend = /weekend/.test(lower);
    const allowedDays = isWeekend ? ["Sat", "Sun"] : ["Mon", "Tue", "Wed", "Thu", "Fri"];
    const config = { allowedDays };
    if (existingWeekday) {
      return {
        ops: [{ op: "update_node_config", nodeId: existingWeekday.id, config }],
        summary: `Updated a schedule filter: only run on ${isWeekend ? "weekends" : "weekdays"}.`,
        schemaType: "schedule.weekday_filter",
      };
    }
    const newNode = makeNode("schedule.weekday_filter", config);
    return {
      ops: insertAfterTriggerOps(before, existingTrigger, newNode),
      summary: `Added a schedule filter: only run on ${isWeekend ? "weekends" : "weekdays"}.`,
      schemaType: "schedule.weekday_filter",
    };
  }

  return null;
}

type ScenarioKind =
  | "timeout"
  | "fail"
  | "provider_switch"
  | "tool_failure"
  | "self_correct"
  | "explain"
  | "build";

function pickScenario(lower: string): ScenarioKind {
  if (/\btimeout\b/.test(lower)) return "timeout";
  if (/\bfail\b/.test(lower)) return "fail";
  if (/\bprovider\b/.test(lower)) return "provider_switch";
  if (/\btool\b/.test(lower)) return "tool_failure";
  if (/\b(bad|broken)\b/.test(lower)) return "self_correct";
  if (/\bwhy\b/.test(lower) || /\bexplain\b/.test(lower)) return "explain";
  return "build";
}

const FALLBACK_MESSAGE = "send a slack message when stripe receives a payment";

export class MockProvider implements LlmProvider {
  readonly name = "mock";

  async *run(ctx: TurnContext): AsyncIterable<ProviderDelta> {
    const lower = ctx.userMessage.toLowerCase();
    switch (pickScenario(lower)) {
      case "timeout":
        yield* this.runTimeout();
        return;
      case "fail":
        yield* this.runFail();
        return;
      case "provider_switch":
        yield* this.runProviderSwitch(ctx, lower);
        return;
      case "tool_failure":
        yield* this.runToolFailure(ctx, lower);
        return;
      case "self_correct":
        yield* this.runSelfCorrect(ctx, lower);
        return;
      case "explain":
        yield* this.runExplain(ctx, lower);
        return;
      case "build":
      default:
        yield* this.runBuild(ctx, lower);
        return;
    }
  }

  // The scripted branches below are plain (synchronous) generators — none of
  // them perform real async work, since MockProvider precomputes its whole
  // scripted turn up front (see module doc). Only runTimeout() genuinely
  // awaits anything. A sync generator satisfies `yield*` from within the
  // async `run()` generator above just fine.
  private *runBuild(ctx: TurnContext, lower: string): Generator<ProviderDelta> {
    yield {
      type: "tool_use",
      callId: randomUUID(),
      tool: "search_nodes",
      input: { query: lower.slice(0, 60) },
    };

    const mutation = computeMutationOps(ctx.currentGraph, ctx.catalog, lower);
    if (!mutation) {
      yield {
        type: "text",
        text: 'I\'m not sure how to change the workflow for that yet. Try describing a trigger and an action, for example "send a Slack message when Stripe receives a payment."',
      };
      yield { type: "finish", reason: "end_turn" };
      return;
    }

    yield {
      type: "tool_use",
      callId: randomUUID(),
      tool: "get_node_schema",
      input: { type: mutation.schemaType },
    };
    yield {
      type: "tool_use",
      callId: randomUUID(),
      tool: "propose_operations",
      input: { ops: mutation.ops, summary: mutation.summary },
    };
    yield { type: "finish", reason: "tool_use" };
  }

  private *runExplain(ctx: TurnContext, lower: string): Generator<ProviderDelta> {
    yield { type: "tool_use", callId: randomUUID(), tool: "get_current_workflow", input: {} };

    const isWhy = /\bwhy\b/.test(lower);
    const graph = ctx.currentGraph;
    let text: string;
    if (graph.nodes.length === 0) {
      text = "There's no workflow yet. Describe what you'd like to automate and I'll build one.";
    } else if (isWhy) {
      text = ctx.isFirstVersion
        ? "This is the first version of the workflow — I created it because you asked me to build it."
        : `I made that change because you asked: "${ctx.lastChangeSummary ?? "a workflow update"}"`;
    } else {
      const names = graph.nodes.map(
        (n) => ctx.catalog.find((c) => c.type === n.type)?.displayName ?? n.type,
      );
      text = `This workflow has ${graph.nodes.length} step${graph.nodes.length === 1 ? "" : "s"}: ${names.join(" → ")}.`;
    }

    yield { type: "text", text };
    yield { type: "finish", reason: "end_turn" };
  }

  private *runSelfCorrect(ctx: TurnContext, lower: string): Generator<ProviderDelta> {
    const cleaned = lower.replace(/\b(bad|broken)\b/g, "").trim();
    yield {
      type: "tool_use",
      callId: randomUUID(),
      tool: "search_nodes",
      input: { query: cleaned },
    };

    if (ctx.attempt === 1) {
      // Deliberately propose a config missing a required field ("channel")
      // so the validator's INVALID_CONFIG check fires — the thing this
      // scenario exists to demonstrate self-correcting from.
      const trigger = makeNode("stripe.payment_received", { currency: "usd" });
      const action = makeNode("slack.send_message", { text: "Payment received" });
      yield {
        type: "tool_use",
        callId: randomUUID(),
        tool: "propose_operations",
        input: {
          ops: [
            { op: "add_node", node: trigger },
            { op: "add_node", node: action },
            { op: "add_edge", edge: makeEdge(trigger.id, action.id) },
          ] satisfies Operation[],
          summary: "Draft: Stripe payment received → send a Slack message.",
        },
      };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    // Repair attempt: discard the broken draft and propose fresh, valid ops.
    const mutation =
      computeMutationOps(ctx.currentGraph, ctx.catalog, cleaned) ??
      computeMutationOps(ctx.currentGraph, ctx.catalog, FALLBACK_MESSAGE);
    if (mutation) {
      yield {
        type: "tool_use",
        callId: randomUUID(),
        tool: "propose_operations",
        input: { ops: mutation.ops, summary: mutation.summary },
      };
    }
    yield { type: "finish", reason: "tool_use" };
  }

  private *runFail(): Generator<ProviderDelta> {
    yield {
      type: "tool_use",
      callId: randomUUID(),
      tool: "search_nodes",
      input: { query: "workflow" },
    };
    // Always hallucinates a node type that doesn't exist in the catalog, on
    // every attempt — the point of this scenario is exhausting the
    // self-correction budget and ending in run.failed.
    const bogus = makeNode("totally.unknown.node_type", {});
    yield {
      type: "tool_use",
      callId: randomUUID(),
      tool: "propose_operations",
      input: {
        ops: [{ op: "add_node", node: bogus }] satisfies Operation[],
        summary: "Draft workflow using an unrecognized node type.",
      },
    };
    yield { type: "finish", reason: "tool_use" };
  }

  private *runProviderSwitch(ctx: TurnContext, lower: string): Generator<ProviderDelta> {
    yield {
      type: "provider_switch",
      from: "anthropic",
      to: "mock",
      reason: "provider unavailable, failing over",
    };
    const cleaned = lower.replace(/\bprovider\b/g, "").trim();
    yield {
      type: "tool_use",
      callId: randomUUID(),
      tool: "search_nodes",
      input: { query: cleaned },
    };
    const mutation =
      computeMutationOps(ctx.currentGraph, ctx.catalog, cleaned) ??
      computeMutationOps(ctx.currentGraph, ctx.catalog, FALLBACK_MESSAGE);
    if (mutation) {
      yield {
        type: "tool_use",
        callId: randomUUID(),
        tool: "propose_operations",
        input: { ops: mutation.ops, summary: mutation.summary },
      };
    }
    yield { type: "finish", reason: "tool_use" };
  }

  private *runToolFailure(ctx: TurnContext, lower: string): Generator<ProviderDelta> {
    const cleaned = lower.replace(/\btool\b/g, "").trim();
    yield {
      type: "tool_use",
      callId: randomUUID(),
      tool: "search_nodes",
      input: { query: cleaned, _simulateFailure: true },
    };
    yield {
      type: "tool_use",
      callId: randomUUID(),
      tool: "search_nodes",
      input: { query: cleaned },
    };
    const mutation =
      computeMutationOps(ctx.currentGraph, ctx.catalog, cleaned) ??
      computeMutationOps(ctx.currentGraph, ctx.catalog, FALLBACK_MESSAGE);
    if (mutation) {
      yield {
        type: "tool_use",
        callId: randomUUID(),
        tool: "propose_operations",
        input: { ops: mutation.ops, summary: mutation.summary },
      };
    }
    yield { type: "finish", reason: "tool_use" };
  }

  private async *runTimeout(): AsyncIterable<ProviderDelta> {
    yield { type: "tool_use", callId: randomUUID(), tool: "search_nodes", input: { query: "workflow" } };
    // Deliberately never yields "finish" or a propose_operations call within
    // any reasonable time — the orchestrator's RUN_DEADLINE_MS race (see
    // agent/orchestrator.ts) is what actually ends this run with run.timeout.
    await new Promise<never>(() => {
      /* never resolves; abandoned once the orchestrator's deadline wins the race */
    });
  }
}
