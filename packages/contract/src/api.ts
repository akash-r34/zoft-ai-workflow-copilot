import { z } from "zod";
import type { WorkflowGraph } from "./workflow.js";

// ── Pagination ────────────────────────────────────────────────────────────────
export const CursorSchema = z.object({ cursor: z.string().optional() });

// ── Conversations ─────────────────────────────────────────────────────────────
export const CreateConversationBodySchema = z.object({
  title: z.string().optional(),
});
export type CreateConversationBody = z.infer<typeof CreateConversationBodySchema>;

export interface ConversationDto {
  id:         string;
  title:      string;
  workflowId: string | null;
  createdAt:  string;
  updatedAt:  string;
}

export interface MessageDto {
  id:             string;
  conversationId: string;
  role:           "user" | "assistant";
  content:        string;
  runId:          string | null;
  createdAt:      string;
}

// ── Runs ──────────────────────────────────────────────────────────────────────
export const CreateRunBodySchema = z.object({
  content: z.string().min(1),
});
export type CreateRunBody = z.infer<typeof CreateRunBodySchema>;

export interface CreateRunResponseDto {
  runId:     string;
  messageId: string;
}

export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

// ── Workflows ─────────────────────────────────────────────────────────────────
export interface WorkflowVersionSummaryDto {
  version:       number;
  createdBy:     "user" | "ai";
  changeSummary: string;
  createdAt:     string;
}

export interface WorkflowDto {
  id:             string;
  name:           string;
  currentVersion: {
    version: number;
    graph:   WorkflowGraph;
  } | null;
}

export interface WorkflowDiffDto {
  from:    number;
  to:      number;
  added:   { nodes: WorkflowGraph["nodes"]; edges: WorkflowGraph["edges"] };
  removed: { nodes: WorkflowGraph["nodes"]; edges: WorkflowGraph["edges"] };
  changed: Array<{
    id:     string;
    before: WorkflowGraph["nodes"][number];
    after:  WorkflowGraph["nodes"][number];
  }>;
}

// ── Node catalog ──────────────────────────────────────────────────────────────
export interface NodeDefinitionDto {
  type:        string;
  category:    "trigger" | "action";
  displayName: string;
  description: string;
  provider:    string;
  configSchema: Record<string, unknown>;
  inputs:      Array<{ name: string; type: string }>;
  outputs:     Array<{ name: string; type: string }>;
}

// ── Dev stubs ─────────────────────────────────────────────────────────────────
export const SimulateStripePaymentBodySchema = z.object({
  amount:   z.number().positive(),
  currency: z.string().default("usd"),
});
export type SimulateStripePaymentBody = z.infer<typeof SimulateStripePaymentBodySchema>;
