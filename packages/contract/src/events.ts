import type { WorkflowGraph, WorkflowNode, WorkflowEdge, ValidationError } from "./workflow.js";
import type { ApiError } from "./errors.js";

export interface WorkflowDiff {
  added:   { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  removed: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  changed: Array<{ id: string; before: WorkflowNode; after: WorkflowNode }>;
}

// Every event carries a monotonic seq scoped to its run
interface BaseEvent { seq: number }

export type SseEvent =
  | (BaseEvent & { event: "run.started";          data: { runId: string } })
  | (BaseEvent & { event: "agent.step";           data: { kind: AgentStepKind; label: string } })
  | (BaseEvent & { event: "token";                data: { text: string } })
  | (BaseEvent & { event: "tool.call";            data: { tool: string; input: unknown; callId: string } })
  | (BaseEvent & { event: "tool.result";          data: { callId: string; ok: boolean; result?: unknown; error?: string } })
  | (BaseEvent & { event: "validation.progress";  data: { stage: string; pct: number } })
  | (BaseEvent & { event: "validation.error";     data: { errors: ValidationError[] } })
  | (BaseEvent & { event: "workflow.proposed";     data: { workflowId: string; version: number; graph: WorkflowGraph; diff: WorkflowDiff; summary: string } })
  | (BaseEvent & { event: "workflow.updated";      data: { workflowId: string; version: number; graph: WorkflowGraph; diff: WorkflowDiff } })
  | (BaseEvent & { event: "retry";                data: { attempt: number; max: number; reason: string } })
  | (BaseEvent & { event: "provider.switched";    data: { from: string; to: string; reason: string } })
  | (BaseEvent & { event: "run.completed";        data: { runId: string } })
  | (BaseEvent & { event: "run.failed";           data: { runId: string; error: ApiError } })
  | (BaseEvent & { event: "run.timeout";          data: { runId: string; draftAvailable: boolean } })
  | (BaseEvent & { event: "run.cancelled";        data: { runId: string } })
  | (BaseEvent & { event: "heartbeat";            data: Record<string, never> });

export type AgentStepKind =
  | "planning"
  | "searching_nodes"
  | "reading_schema"
  | "validating"
  | "proposing"
  | "repair";

// Re-export for convenience
export type { ApiError } from "./errors.js";
