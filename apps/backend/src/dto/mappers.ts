// Prisma row -> @zoft/contract DTO mappers. Mirrors apps/frontend/mock/server.ts's
// toConversationDto/toMessageDto/toWorkflowDto/toVersionSummaryDto/toVersionDetailDto
// so the real backend's REST responses are byte-compatible with what the
// frontend's lib/api.ts already decodes.
import type { Conversation, Message, Workflow, WorkflowVersion } from "@prisma/client";
import type {
  ConversationDto,
  MessageDto,
  WorkflowDto,
  WorkflowGraph,
  WorkflowVersionSummaryDto,
} from "@zoft/contract";

export function toConversationDto(c: Conversation): ConversationDto {
  return {
    id: c.id,
    title: c.title,
    workflowId: c.workflowId,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function toMessageDto(m: Message): MessageDto {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    runId: m.runId,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toWorkflowDto(
  workflow: Workflow,
  currentVersion: WorkflowVersion | null,
): WorkflowDto {
  return {
    id: workflow.id,
    name: workflow.name,
    currentVersion: currentVersion
      ? { version: currentVersion.version, graph: currentVersion.graph as unknown as WorkflowGraph }
      : null,
  };
}

export function toVersionSummaryDto(v: WorkflowVersion): WorkflowVersionSummaryDto {
  return {
    version: v.version,
    createdBy: v.createdBy as "user" | "ai",
    changeSummary: v.changeSummary,
    createdAt: v.createdAt.toISOString(),
  };
}

// The mock returns the full version row for both "get one version" and
// "restore" (apps/frontend/src/lib/api.ts's VersionDetail) — not yet a named
// contract DTO, per its own comment; matched here for byte-compatibility.
export interface VersionDetailDto {
  version: number;
  graph: WorkflowGraph;
  createdBy: "user" | "ai";
  changeSummary: string;
  createdAt: string;
}

export function toVersionDetailDto(v: WorkflowVersion): VersionDetailDto {
  return {
    version: v.version,
    graph: v.graph as unknown as WorkflowGraph,
    createdBy: v.createdBy as "user" | "ai",
    changeSummary: v.changeSummary,
    createdAt: v.createdAt.toISOString(),
  };
}
