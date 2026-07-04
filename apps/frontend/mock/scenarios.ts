// The mock's deterministic "AI". No LLM call here — a keyword match on the
// user's message picks a scripted sequence of SSE events (with realistic
// pacing) that mirrors what the real agent loop in apps/backend/src/agent/
// orchestrator.ts emits: plan -> search nodes -> read schema -> validate ->
// propose -> (pause for human approval, PRD v1.1 Decision #1) -> commit.
// Every event goes through store.appendEvent, so it is persisted for replay
// and pushed to any live subscriber in the same call.
import { randomUUID } from "node:crypto";
import type { AgentStepKind, ValidationError, WorkflowGraph, WorkflowNode } from "@zoft/contract";
import { NODE_CATALOG, findCatalogEntry, isTriggerType } from "./catalog.js";
import { EMPTY, cloneGraph, diffGraphs, makeEdge, makeNode } from "./graph-ops.js";
import {
  addMessage,
  appendEvent,
  getCurrentVersion,
  isCancelRequested,
  setPendingProposal,
  setRunStatus,
} from "./store.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits, then reports whether the run should continue. Emits run.cancelled and stops it if not. */
async function tick(runId: string, delayMs: number): Promise<boolean> {
  await sleep(delayMs);
  if (isCancelRequested(runId)) {
    appendEvent(runId, { event: "run.cancelled", data: { runId } });
    setRunStatus(runId, "cancelled");
    return false;
  }
  return true;
}

async function emitProse(runId: string, text: string, delayMs: number): Promise<boolean> {
  const chunks = text.match(/\s*\S+/g) ?? [text];
  for (const chunk of chunks) {
    if (!(await tick(runId, delayMs))) return false;
    appendEvent(runId, { event: "token", data: { text: chunk } });
  }
  return true;
}

type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** Announces an agent.step for the given kind, then runs a tool.call/tool.result pair. */
async function runToolCall(
  runId: string,
  step: { kind: AgentStepKind; label: string },
  tool: string,
  input: unknown,
  outcome: ToolOutcome,
): Promise<boolean> {
  if (!(await tick(runId, 400))) return false;
  appendEvent(runId, { event: "agent.step", data: step });
  if (!(await tick(runId, 350))) return false;
  const callId = randomUUID();
  appendEvent(runId, { event: "tool.call", data: { tool, input, callId } });
  if (!(await tick(runId, 350))) return false;
  appendEvent(
    runId,
    outcome.ok
      ? { event: "tool.result", data: { callId, ok: true, result: outcome.result } }
      : { event: "tool.result", data: { callId, ok: false, error: outcome.error } },
  );
  return true;
}

function makeValidationError(code: string, message: string, nodeId?: string): ValidationError {
  return nodeId !== undefined ? { code, message, nodeId } : { code, message };
}

// ── Graph mutation helpers ───────────────────────────────────────────────
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

function replaceNode(
  graph: WorkflowGraph,
  nodeId: string,
  newType: string,
  config: Record<string, unknown>,
): WorkflowGraph {
  const next = cloneGraph(graph);
  const node = next.nodes.find((n) => n.id === nodeId);
  if (node) {
    node.type = newType;
    node.config = config;
  }
  return next;
}

function updateNodeConfig(
  graph: WorkflowGraph,
  nodeId: string,
  config: Record<string, unknown>,
): WorkflowGraph {
  const next = cloneGraph(graph);
  const node = next.nodes.find((n) => n.id === nodeId);
  if (node) node.config = config;
  return next;
}

function insertAfterTrigger(graph: WorkflowGraph, newNode: WorkflowNode): WorkflowGraph {
  const next = cloneGraph(graph);
  const trigger = next.nodes.find((n) => isTriggerType(n.type));
  if (!trigger) return next;
  next.nodes.push(newNode);
  for (const edge of next.edges) {
    if (edge.source === trigger.id) edge.source = newNode.id;
  }
  next.edges.push(makeEdge(trigger.id, newNode.id));
  return next;
}

interface Mutation {
  graph: WorkflowGraph;
  summary: string;
  schemaType: string;
}

/** Keyword-driven graph edit. Returns null when the message doesn't map to a known change. */
function computeMutation(before: WorkflowGraph, lower: string): Mutation | null {
  const hasStripe = /stripe/.test(lower);
  const hasSlack = /slack/.test(lower);
  const hasTeams = /teams/.test(lower);
  const hasThreshold = /(above|over|greater than|at least|more than)\s*\$?\s*\d+|\$\d+/.test(lower);
  const hasWeekday = /weekday|weekend/.test(lower);

  const existingTrigger = before.nodes.find((n) => isTriggerType(n.type));
  const existingSlack = before.nodes.find((n) => n.type === "slack.send_message");
  const existingTeams = before.nodes.find((n) => n.type === "teams.send_message");
  const existingFilter = before.nodes.find((n) => n.type === "filter.condition");
  const existingWeekday = before.nodes.find((n) => n.type === "schedule.weekday_filter");

  if (hasTeams && existingSlack && !existingTeams) {
    return {
      graph: replaceNode(before, existingSlack.id, "teams.send_message", teamsConfig()),
      summary: "Replaced the Slack step with a Microsoft Teams message.",
      schemaType: "teams.send_message",
    };
  }

  if (hasSlack && existingTeams && !existingSlack) {
    return {
      graph: replaceNode(before, existingTeams.id, "slack.send_message", slackConfig()),
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
    const graph: WorkflowGraph = {
      nodes: [trigger, action],
      edges: [makeEdge(trigger.id, action.id)],
    };
    const label = actionType === "teams.send_message" ? "Microsoft Teams" : "Slack";
    return {
      graph,
      summary: `Created a workflow: Stripe payment received → send a ${label} message.`,
      schemaType: actionType,
    };
  }

  if (hasThreshold && existingTrigger) {
    const amount = parseAmount(lower);
    const config = { field: "amount", op: "gt", value: amount };
    const graph = existingFilter
      ? updateNodeConfig(before, existingFilter.id, config)
      : insertAfterTrigger(before, makeNode("filter.condition", config));
    return {
      graph,
      summary: `${existingFilter ? "Updated" : "Added"} a condition: only continue when amount > ${amount}.`,
      schemaType: "filter.condition",
    };
  }

  if (hasWeekday && existingTrigger) {
    const isWeekend = /weekend/.test(lower);
    const allowedDays = isWeekend ? ["Sat", "Sun"] : ["Mon", "Tue", "Wed", "Thu", "Fri"];
    const config = { allowedDays };
    const graph = existingWeekday
      ? updateNodeConfig(before, existingWeekday.id, config)
      : insertAfterTrigger(before, makeNode("schedule.weekday_filter", config));
    return {
      graph,
      summary: `${existingWeekday ? "Updated" : "Added"} a schedule filter: only run on ${isWeekend ? "weekends" : "weekdays"}.`,
      schemaType: "schedule.weekday_filter",
    };
  }

  return null;
}

// ── Shared tail: read schema, validate, commit, explain, complete ───────
async function completeBuild(
  runId: string,
  conversationId: string,
  workflowId: string,
  before: WorkflowGraph,
  mutation: Mutation | null,
): Promise<void> {
  if (!mutation) {
    const text =
      'I\'m not sure how to change the workflow for that yet. Try describing a trigger and an action, for example "send a Slack message when Stripe receives a payment."';
    if (!(await emitProse(runId, text, 25))) return;
    addMessage({ conversationId, role: "assistant", content: text, runId });
    appendEvent(runId, { event: "run.completed", data: { runId } });
    setRunStatus(runId, "succeeded");
    return;
  }

  const schemaEntry = findCatalogEntry(mutation.schemaType);
  const ok = await runToolCall(
    runId,
    {
      kind: "reading_schema",
      label: `Reading ${schemaEntry?.displayName ?? mutation.schemaType} schema...`,
    },
    "get_node_schema",
    { type: mutation.schemaType },
    { ok: true, result: schemaEntry?.configSchema ?? {} },
  );
  if (!ok) return;

  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "validating", label: "Calling validator..." },
  });
  if (!(await tick(runId, 250))) return;
  appendEvent(runId, { event: "validation.progress", data: { stage: "schema", pct: 60 } });
  if (!(await tick(runId, 250))) return;
  appendEvent(runId, { event: "validation.progress", data: { stage: "graph", pct: 100 } });

  if (!(await tick(runId, 300))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "proposing", label: "Generating workflow..." },
  });

  if (!(await tick(runId, 300))) return;
  // PRD v1.1 Decision #1 — pause here instead of committing. The candidate
  // graph is validated (simulated above) but NOT yet written; it waits as a
  // pending proposal until POST .../approve or .../reject resolves it (see
  // server.ts). This mirrors the real backend's agent/orchestrator.ts
  // handleProposal exactly, so the frontend's approval-gate UI (Part C)
  // works identically against either backend.
  const diff = diffGraphs(before, mutation.graph);
  const previewVersion = (getCurrentVersion(workflowId)?.version ?? 0) + 1;
  setPendingProposal(runId, { graph: mutation.graph, summary: mutation.summary });

  if (!(await emitProse(runId, mutation.summary, 25))) return;
  addMessage({ conversationId, role: "assistant", content: mutation.summary, runId });
  appendEvent(runId, {
    event: "workflow.proposed",
    data: { workflowId, version: previewVersion, graph: mutation.graph, diff, summary: mutation.summary },
  });
  // Run stays "running" — the heartbeat (server.ts) keeps the stream alive
  // until the approval endpoint resolves it.
}

async function runBuildScenario(
  runId: string,
  conversationId: string,
  workflowId: string,
  before: WorkflowGraph,
  lower: string,
): Promise<void> {
  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "planning", label: "Planning workflow..." },
  });

  const mutation = computeMutation(before, lower);
  const matchedTypes = NODE_CATALOG.filter(
    (n) => lower.includes(n.provider) || lower.includes(n.category),
  ).map((n) => n.type);

  const ok = await runToolCall(
    runId,
    { kind: "searching_nodes", label: "Searching available nodes..." },
    "search_nodes",
    { query: lower.slice(0, 60) },
    { ok: true, result: matchedTypes.length > 0 ? matchedTypes : NODE_CATALOG.map((n) => n.type) },
  );
  if (!ok) return;

  await completeBuild(runId, conversationId, workflowId, before, mutation);
}

async function runExplainScenario(
  runId: string,
  conversationId: string,
  workflowId: string,
  lower: string,
): Promise<void> {
  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "planning", label: "Reviewing the current workflow..." },
  });

  const current = getCurrentVersion(workflowId);
  if (!(await tick(runId, 350))) return;
  const callId = randomUUID();
  appendEvent(runId, {
    event: "tool.call",
    data: { tool: "get_current_workflow", input: {}, callId },
  });
  if (!(await tick(runId, 300))) return;
  appendEvent(runId, {
    event: "tool.result",
    data: { callId, ok: true, result: { nodeCount: current?.graph.nodes.length ?? 0 } },
  });

  const isWhy = /\bwhy\b/.test(lower);
  let text: string;
  if (!current) {
    text = "There's no workflow yet. Describe what you'd like to automate and I'll build one.";
  } else if (isWhy) {
    text = current.parentVersionId
      ? `I made that change because you asked: "${current.changeSummary}"`
      : "This is the first version of the workflow — I created it because you asked me to build it.";
  } else {
    const names = current.graph.nodes.map((n) => findCatalogEntry(n.type)?.displayName ?? n.type);
    text = `This workflow has ${current.graph.nodes.length} step${current.graph.nodes.length === 1 ? "" : "s"}: ${names.join(" → ")}.`;
  }

  if (!(await emitProse(runId, text, 25))) return;
  addMessage({ conversationId, role: "assistant", content: text, runId });
  appendEvent(runId, { event: "run.completed", data: { runId } });
  setRunStatus(runId, "succeeded");
}

async function runSelfCorrectScenario(
  runId: string,
  conversationId: string,
  workflowId: string,
  before: WorkflowGraph,
  lower: string,
): Promise<void> {
  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "planning", label: "Planning workflow..." },
  });

  const cleaned = lower.replace(/\b(bad|broken)\b/g, "").trim();
  const searchOk = await runToolCall(
    runId,
    { kind: "searching_nodes", label: "Searching available nodes..." },
    "search_nodes",
    { query: cleaned },
    { ok: true, result: NODE_CATALOG.map((n) => n.type) },
  );
  if (!searchOk) return;

  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "proposing", label: "Generating workflow..." },
  });

  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "validation.error",
    data: {
      errors: [
        makeValidationError(
          "MISSING_REQUIRED_FIELD",
          "slack.send_message requires a 'channel' field.",
          before.nodes[0]?.id,
        ),
      ],
    },
  });

  if (!(await tick(runId, 300))) return;
  appendEvent(runId, {
    event: "retry",
    data: { attempt: 1, max: 3, reason: "validation failed, correcting configuration" },
  });

  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "repair", label: "Fixing missing configuration" },
  });

  const mutation =
    computeMutation(before, cleaned) ??
    computeMutation(before, "send a slack message when stripe receives a payment");
  await completeBuild(runId, conversationId, workflowId, before, mutation);
}

async function runTimeoutScenario(runId: string): Promise<void> {
  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "planning", label: "Planning workflow..." },
  });
  if (!(await tick(runId, 500))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "validating", label: "Calling validator..." },
  });
  if (!(await tick(runId, 600))) return;
  appendEvent(runId, { event: "run.timeout", data: { runId, draftAvailable: true } });
  setRunStatus(runId, "timed_out");
}

async function runFailScenario(runId: string): Promise<void> {
  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "planning", label: "Planning workflow..." },
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!(await tick(runId, 400))) return;
    appendEvent(runId, {
      event: "agent.step",
      data: { kind: "proposing", label: "Generating workflow..." },
    });
    if (!(await tick(runId, 350))) return;
    appendEvent(runId, {
      event: "validation.error",
      data: {
        errors: [
          makeValidationError(
            "UNKNOWN_NODE_TYPE",
            "The proposed node type does not exist in the catalog.",
          ),
        ],
      },
    });
    if (attempt === 3) break;
    if (!(await tick(runId, 300))) return;
    appendEvent(runId, {
      event: "retry",
      data: { attempt, max: 3, reason: "validation failed, retrying" },
    });
    if (!(await tick(runId, 300))) return;
    appendEvent(runId, {
      event: "agent.step",
      data: { kind: "repair", label: `Fixing missing configuration (attempt ${attempt} of 3)` },
    });
  }

  if (!(await tick(runId, 300))) return;
  appendEvent(runId, {
    event: "run.failed",
    data: {
      runId,
      error: {
        code: "VALIDATION_FAILED",
        message: "The workflow could not be validated after 3 repair attempts.",
        details: ["UNKNOWN_NODE_TYPE"],
      },
    },
  });
  setRunStatus(runId, "failed");
}

async function runProviderSwitchScenario(
  runId: string,
  conversationId: string,
  workflowId: string,
  before: WorkflowGraph,
  lower: string,
): Promise<void> {
  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "planning", label: "Planning workflow..." },
  });
  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "provider.switched",
    data: { from: "anthropic", to: "mock", reason: "provider unavailable, failing over" },
  });

  const cleaned = lower.replace(/\bprovider\b/g, "").trim();
  const searchOk = await runToolCall(
    runId,
    { kind: "searching_nodes", label: "Searching available nodes..." },
    "search_nodes",
    { query: cleaned },
    { ok: true, result: NODE_CATALOG.map((n) => n.type) },
  );
  if (!searchOk) return;

  const mutation =
    computeMutation(before, cleaned) ??
    computeMutation(before, "send a slack message when stripe receives a payment");
  await completeBuild(runId, conversationId, workflowId, before, mutation);
}

async function runToolFailureScenario(
  runId: string,
  conversationId: string,
  workflowId: string,
  before: WorkflowGraph,
  lower: string,
): Promise<void> {
  if (!(await tick(runId, 400))) return;
  appendEvent(runId, {
    event: "agent.step",
    data: { kind: "planning", label: "Planning workflow..." },
  });

  const cleaned = lower.replace(/\btool\b/g, "").trim();
  const failedOk = await runToolCall(
    runId,
    { kind: "searching_nodes", label: "Searching available nodes..." },
    "search_nodes",
    { query: cleaned },
    { ok: false, error: "node search index temporarily unavailable" },
  );
  if (!failedOk) return;

  const retryOk = await runToolCall(
    runId,
    { kind: "searching_nodes", label: "Retrying node search..." },
    "search_nodes",
    { query: cleaned },
    { ok: true, result: NODE_CATALOG.map((n) => n.type) },
  );
  if (!retryOk) return;

  const mutation =
    computeMutation(before, cleaned) ??
    computeMutation(before, "send a slack message when stripe receives a payment");
  await completeBuild(runId, conversationId, workflowId, before, mutation);
}

/** Entry point: run one scripted turn for a run, driven by keywords in the user's message. */
export async function runScenario(
  runId: string,
  conversationId: string,
  workflowId: string,
  content: string,
): Promise<void> {
  setRunStatus(runId, "running");
  appendEvent(runId, { event: "run.started", data: { runId } });

  const lower = content.toLowerCase();
  const before = getCurrentVersion(workflowId)?.graph ?? cloneGraph(EMPTY);

  try {
    if (/\btimeout\b/.test(lower)) return await runTimeoutScenario(runId);
    if (/\bfail\b/.test(lower)) return await runFailScenario(runId);
    if (/\bprovider\b/.test(lower))
      return await runProviderSwitchScenario(runId, conversationId, workflowId, before, lower);
    if (/\btool\b/.test(lower))
      return await runToolFailureScenario(runId, conversationId, workflowId, before, lower);
    if (/\b(bad|broken)\b/.test(lower))
      return await runSelfCorrectScenario(runId, conversationId, workflowId, before, lower);
    if (/\bwhy\b/.test(lower) || /\bexplain\b/.test(lower))
      return await runExplainScenario(runId, conversationId, workflowId, lower);
    return await runBuildScenario(runId, conversationId, workflowId, before, lower);
  } catch (err) {
    appendEvent(runId, {
      event: "run.failed",
      data: {
        runId,
        error: {
          code: "INTERNAL",
          message: err instanceof Error ? err.message : "internal mock error",
        },
      },
    });
    setRunStatus(runId, "failed");
  }
}
