// Internal storage shapes for the mock. These are NOT contract types — they
// are the mock's private persistence model, analogous to Prisma rows on the
// real backend. Every REST response is mapped from these into the real
// @zoft/contract DTOs at the route boundary (see server.ts).
import type { SseEvent, WorkflowGraph } from "@zoft/contract";

export interface StoredConversation {
  id: string;
  title: string;
  workflowId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  runId: string | null;
  createdAt: string;
}

export interface StoredWorkflow {
  id: string;
  name: string;
  currentVersionId: string | null;
}

export interface StoredWorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  graph: WorkflowGraph;
  createdBy: "user" | "ai";
  changeSummary: string;
  parentVersionId: string | null;
  createdAt: string;
}

export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface StoredRun {
  id: string;
  conversationId: string;
  workflowId: string;
  status: RunStatus;
  cancelRequested: boolean;
  createdAt: string;
}

export interface StoreSnapshot {
  conversations: Record<string, StoredConversation>;
  messages: Record<string, StoredMessage>;
  workflows: Record<string, StoredWorkflow>;
  workflowVersions: Record<string, StoredWorkflowVersion>;
  runs: Record<string, StoredRun>;
  runEvents: Record<string, SseEvent[]>;
}

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
