// The agent loop. Drives a provider's deltas through the real tool registry,
// enforces the self-correction budget and the run deadline, and — per PRD
// v1.1 Decision #1 — pauses at a validated proposal instead of committing,
// leaving the run "running" until a human calls POST .../approve or
// .../reject (see routes/runs.ts). This is the only module that decides
// *when* a proposal is ready; it never writes a workflow_version itself
// (tools/commit.ts does that, and only from the approve route handler).
import type { Prisma } from "@prisma/client";
import type { NodeDefinitionDto, Operation, ValidationError, WorkflowGraph } from "@zoft/contract";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { loadCatalog, toCatalogEntries } from "../catalog/catalog-service.js";
import { executeTool } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { ProposeOutcome } from "../tools/propose-operations.js";
import { commitProposal } from "../tools/commit.js";
import type { LlmProvider, ProviderDelta, TurnContext } from "../providers/types.js";
import { diffGraphs } from "../dto/diff.js";
import { appendEvent, clearRunState } from "../runs/event-bus.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Paced like apps/frontend/mock/scenarios.ts's tick() helper — small,
// deliberate delays between steps so the frontend's activity timeline
// streams visibly instead of resolving in a single tick, and so a "Stop"
// click has a real window to land before the run finishes.
async function tick(runId: string, ms: number): Promise<boolean> {
  await sleep(ms);
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { cancelRequested: true } });
  return !(run?.cancelRequested ?? false);
}

function deriveStep(tool: string): { kind: "searching_nodes" | "reading_schema" | "validating"; label: string } {
  switch (tool) {
    case "search_nodes":
      return { kind: "searching_nodes", label: "Searching available nodes..." };
    case "get_node_schema":
      return { kind: "reading_schema", label: "Reading node schema..." };
    case "get_current_workflow":
      return { kind: "searching_nodes", label: "Reading current workflow..." };
    case "propose_operations":
    default:
      return { kind: "validating", label: "Calling validator..." };
  }
}

interface DeadlineWin {
  readonly _brand: "deadline";
}
const DEADLINE: DeadlineWin = { _brand: "deadline" };

function createDeadline(ms: number): { promise: Promise<DeadlineWin>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<DeadlineWin>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function persistAssistantMessage(
  conversationId: string,
  runId: string,
  content: string,
): Promise<void> {
  if (content.trim().length === 0) return;
  await prisma.message.create({
    data: { conversationId, role: "assistant", content, runId },
  });
}

/** Runs one full agent turn for `runId`. Never throws — every failure path emits a terminal SSE event and updates run.status before returning. */
export async function runOrchestrator(
  provider: LlmProvider,
  runId: string,
  conversationId: string,
  workflowId: string,
  userMessage: string,
): Promise<void> {
  const deadline = createDeadline(env.RUN_DEADLINE_MS);
  const outcome = await Promise.race([
    mainLoop(provider, runId, conversationId, workflowId, userMessage),
    deadline.promise,
  ]);
  deadline.cancel();

  if (outcome === DEADLINE) {
    await appendEvent(runId, { event: "run.timeout", data: { runId, draftAvailable: false } });
    await prisma.run.update({ where: { id: runId }, data: { status: "timed_out" } }).catch(() => undefined);
    await clearRunState(runId);
  }
}

async function mainLoop(
  provider: LlmProvider,
  runId: string,
  conversationId: string,
  workflowId: string,
  userMessage: string,
): Promise<void> {
  await appendEvent(runId, { event: "run.started", data: { runId } });
  if (!(await tick(runId, 300))) return cancelRun(runId);

  const catalog: NodeDefinitionDto[] = await loadCatalog(prisma);
  const catalogEntries = toCatalogEntries(catalog);

  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    include: { currentVersion: true },
  });
  const currentGraph: WorkflowGraph =
    (workflow?.currentVersion?.graph as unknown as WorkflowGraph | undefined) ?? { nodes: [], edges: [] };

  await appendEvent(runId, {
    event: "agent.step",
    data: { kind: "planning", label: "Planning workflow..." },
  });
  if (!(await tick(runId, 350))) return cancelRun(runId);

  const toolCtx: ToolContext = {
    prisma,
    workflowId,
    catalog,
    catalogEntries,
    currentGraph,
  };

  const maxAttempts = env.SELF_CORRECTION_BUDGET + 1;
  let attempt = 1;
  let priorErrors: TurnContext["priorErrors"];
  let accumulatedText = "";

  while (attempt <= maxAttempts) {
    const ctx: TurnContext = {
      userMessage,
      currentGraph,
      catalog,
      attempt,
      ...(priorErrors ? { priorErrors } : {}),
      ...(workflow?.currentVersion ? { lastChangeSummary: workflow.currentVersion.changeSummary } : {}),
      isFirstVersion: !workflow?.currentVersion?.parentVersionId,
    };

    let shouldRetryTurn = false;

    for await (const delta of provider.run(ctx)) {
      if (!(await tick(runId, 150))) return cancelRun(runId);

      const outcome = await handleDelta(runId, conversationId, toolCtx, delta);

      switch (outcome.kind) {
        case "text":
          accumulatedText += outcome.text;
          continue;
        case "continue":
          continue;
        case "cancelled":
          return;
        case "proposed":
          await handleProposal(runId, conversationId, workflowId, currentGraph, outcome);
          return;
        case "validation_failed":
          // Always surface the structured errors as their own event — the
          // frontend's step-map.ts renders a dedicated "Validation found
          // problems" row from this, separate from the raw tool.result the
          // propose_operations call already emitted.
          await appendEvent(runId, { event: "validation.error", data: { errors: outcome.errors } });
          if (attempt < maxAttempts) {
            if (!(await tick(runId, 300))) return cancelRun(runId);
            await appendEvent(runId, {
              event: "retry",
              data: { attempt, max: maxAttempts, reason: "validation failed, correcting configuration" },
            });
            if (!(await tick(runId, 300))) return cancelRun(runId);
            await appendEvent(runId, {
              event: "agent.step",
              data: { kind: "repair", label: `Fixing configuration (attempt ${attempt} of ${maxAttempts})` },
            });
            attempt += 1;
            priorErrors = outcome.errors;
            shouldRetryTurn = true;
            break; // switch-break only; falls through to the shared loop-break below
          }
          await appendEvent(runId, {
            event: "run.failed",
            data: {
              runId,
              error: {
                code: "VALIDATION_FAILED",
                message: `The workflow could not be validated after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}.`,
                details: outcome.errors.map((e) => e.code),
              },
            },
          });
          await prisma.run.update({ where: { id: runId }, data: { status: "failed" } });
          await clearRunState(runId);
          return;
        case "finish":
          break; // switch-break only; falls through to the shared loop-break below
      }
      // Reached only via a validation_failed-with-retry or a plain finish —
      // both stop consuming this attempt's deltas. "text"/"continue" hit
      // `continue` above and never reach here; "cancelled"/"proposed"/the
      // exhausted-budget branch of "validation_failed" all `return` above.
      break;
    }

    if (shouldRetryTurn) continue; // re-invoke provider.run() with the bumped attempt
    break; // plain finish, or the generator ended with no mutation proposed
  }

  // Reached only for non-mutating turns (explain, "I don't understand", or a
  // finish with no propose_operations ever called) — no proposal, no write.
  await persistAssistantMessage(conversationId, runId, accumulatedText);
  await appendEvent(runId, { event: "run.completed", data: { runId } });
  await prisma.run.update({ where: { id: runId }, data: { status: "succeeded" } });
  await clearRunState(runId);
}

async function cancelRun(runId: string): Promise<void> {
  await appendEvent(runId, { event: "run.cancelled", data: { runId } });
  await prisma.run.update({ where: { id: runId }, data: { status: "cancelled" } }).catch(() => undefined);
  await clearRunState(runId);
}

type DeltaOutcome =
  | { kind: "text"; text: string }
  | { kind: "continue" }
  | { kind: "finish" }
  | { kind: "cancelled" }
  | { kind: "proposed"; ops: Operation[]; graph: WorkflowGraph; summary: string }
  | { kind: "validation_failed"; errors: ValidationError[] };

async function handleDelta(
  runId: string,
  _conversationId: string,
  toolCtx: ToolContext,
  delta: ProviderDelta,
): Promise<DeltaOutcome> {
  if (delta.type === "text") {
    await appendEvent(runId, { event: "token", data: { text: delta.text } });
    return { kind: "text", text: delta.text };
  }

  if (delta.type === "provider_switch") {
    await appendEvent(runId, {
      event: "provider.switched",
      data: { from: delta.from, to: delta.to, reason: delta.reason },
    });
    // NOT terminal — the provider keeps yielding deltas after a failover
    // (see MockProvider.runProviderSwitch), so the loop must keep consuming.
    return { kind: "continue" };
  }

  if (delta.type === "finish") {
    return { kind: "finish" };
  }

  // tool_use
  const step = deriveStep(delta.tool);
  await appendEvent(runId, { event: "agent.step", data: step });
  if (!(await tick(runId, 250))) return { kind: "cancelled" };

  await appendEvent(runId, {
    event: "tool.call",
    data: { tool: delta.tool, input: delta.input, callId: delta.callId },
  });
  if (!(await tick(runId, 250))) return { kind: "cancelled" };

  const result = await executeTool(toolCtx, delta.tool, delta.input);
  await appendEvent(
    runId,
    result.ok
      ? { event: "tool.result", data: { callId: delta.callId, ok: true, result: result.result } }
      : { event: "tool.result", data: { callId: delta.callId, ok: false, error: result.error } },
  );

  if (delta.tool === "propose_operations" && result.ok) {
    const proposeOutcome = result.result as ProposeOutcome;
    if (proposeOutcome.valid) {
      const input = delta.input as { ops: Operation[]; summary?: string };
      return {
        kind: "proposed",
        ops: input.ops,
        graph: proposeOutcome.graph,
        summary: input.summary ?? "Workflow updated.",
      };
    }
    return { kind: "validation_failed", errors: proposeOutcome.errors };
  }

  // Any other tool call (search_nodes, get_node_schema, get_current_workflow,
  // or a failed/unknown tool the script handles by retrying) is NOT terminal
  // — the provider's generator still has more deltas to yield (e.g. the next
  // tool call, or the closing "finish"). Only an explicit `finish` delta or a
  // validated/invalid propose_operations ends this attempt.
  return { kind: "continue" };
}

async function handleProposal(
  runId: string,
  conversationId: string,
  workflowId: string,
  before: WorkflowGraph,
  proposal: { ops: Operation[]; graph: WorkflowGraph; summary: string },
): Promise<void> {
  const diff = diffGraphs(before, proposal.graph);

  if (!env.APPROVAL_REQUIRED) {
    // Legacy/test path: commit immediately, matching the pre-v1.1 mock's
    // auto-commit behavior. See config/env.ts's APPROVAL_REQUIRED doc.
    const catalog = toCatalogEntries(await loadCatalog(prisma));
    const committed = await commitProposal(prisma, workflowId, proposal.ops, catalog, proposal.summary);
    if ("error" in committed) {
      await appendEvent(runId, { event: "validation.error", data: { errors: committed.error } });
      await appendEvent(runId, {
        event: "run.failed",
        data: { runId, error: { code: "VALIDATION_FAILED", message: "Commit-time validation failed." } },
      });
      await prisma.run.update({ where: { id: runId }, data: { status: "failed" } });
      await clearRunState(runId);
      return;
    }
    await appendEvent(runId, {
      event: "workflow.updated",
      data: { workflowId, version: committed.version, graph: committed.graph, diff },
    });
    await persistAssistantMessage(conversationId, runId, proposal.summary);
    await appendEvent(runId, { event: "run.completed", data: { runId } });
    await prisma.run.update({ where: { id: runId }, data: { status: "succeeded" } });
    await clearRunState(runId);
    return;
  }

  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    include: { currentVersion: true },
  });
  const previewVersion = (workflow?.currentVersion?.version ?? 0) + 1;

  await prisma.run.update({
    where: { id: runId },
    data: {
      proposedOps: proposal.ops as unknown as Prisma.InputJsonValue,
      proposedGraph: proposal.graph as unknown as Prisma.InputJsonValue,
      proposalSummary: proposal.summary,
      proposalStatus: "pending",
    },
  });

  await persistAssistantMessage(conversationId, runId, proposal.summary);
  await appendEvent(runId, {
    event: "workflow.proposed",
    data: { workflowId, version: previewVersion, graph: proposal.graph, diff, summary: proposal.summary },
  });
  // The run stays "running" — heartbeats (see runs/sse.ts) keep the stream
  // alive until POST /api/runs/:runId/approve or /reject resolves it.
}
