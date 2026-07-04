// Typed REST client over the mock (or, unchanged, a real) backend. Every
// function returns a @zoft/contract DTO — this file is the only place that
// knows the wire shape of an HTTP response.
import type {
  ApproveRunResponseDto,
  ConversationDto,
  ErrorEnvelope,
  MessageDto,
  CreateRunResponseDto,
  NodeDefinitionDto,
  RejectRunResponseDto,
  WorkflowDiffDto,
  WorkflowDto,
  WorkflowGraph,
  WorkflowVersionSummaryDto,
} from "@zoft/contract";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export class ApiRequestError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    // Only set Content-Type when there's an actual body — Fastify rejects an
    // empty body sent with application/json (e.g. the bodyless cancel/restore POSTs).
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorEnvelope | null;
    throw new ApiRequestError(
      body?.error.code ?? "INTERNAL",
      body?.error.message ?? `Request failed with status ${res.status}`,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

// The mock returns the full version row for both "get one version" and
// "restore" — a superset of WorkflowDiffDto's node shape, not yet a named
// contract DTO since 04-api-contract.md leaves that response shape open.
export interface VersionDetail {
  version: number;
  graph: WorkflowGraph;
  createdBy: "user" | "ai";
  changeSummary: string;
  createdAt: string;
}

export const api = {
  createConversation: (title?: string) =>
    request<ConversationDto>("/api/conversations", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    }),

  listConversations: () => request<ConversationDto[]>("/api/conversations"),

  listMessages: (conversationId: string) =>
    request<MessageDto[]>(`/api/conversations/${conversationId}/messages`),

  createRun: (conversationId: string, content: string) =>
    request<CreateRunResponseDto>(`/api/conversations/${conversationId}/runs`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  cancelRun: (runId: string) =>
    request<{ status: "cancelled" }>(`/api/runs/${runId}/cancel`, { method: "POST" }),

  approveRun: (runId: string) =>
    request<ApproveRunResponseDto>(`/api/runs/${runId}/approve`, { method: "POST" }),

  rejectRun: (runId: string) =>
    request<RejectRunResponseDto>(`/api/runs/${runId}/reject`, { method: "POST" }),

  getWorkflow: (workflowId: string) => request<WorkflowDto>(`/api/workflows/${workflowId}`),

  listVersions: (workflowId: string) =>
    request<WorkflowVersionSummaryDto[]>(`/api/workflows/${workflowId}/versions`),

  getVersion: (workflowId: string, version: number) =>
    request<VersionDetail>(`/api/workflows/${workflowId}/versions/${version}`),

  getDiff: (workflowId: string, from: number, to: number) =>
    request<WorkflowDiffDto>(`/api/workflows/${workflowId}/diff?from=${from}&to=${to}`),

  restoreVersion: (workflowId: string, version: number) =>
    request<VersionDetail>(`/api/workflows/${workflowId}/versions/${version}/restore`, {
      method: "POST",
    }),

  listNodeDefinitions: (query?: string) =>
    request<NodeDefinitionDto[]>(
      `/api/node-definitions${query ? `?query=${encodeURIComponent(query)}` : ""}`,
    ),
};

export function runStreamUrl(runId: string): string {
  return `${API_URL}/api/runs/${runId}/stream`;
}
