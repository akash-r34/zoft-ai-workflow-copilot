// Run lifecycle: creating the workflow-on-first-message (mirrors
// apps/frontend/mock/store.ts's ensureWorkflow), creating the run + user
// message rows, and launching the orchestrator fire-and-forget so the REST
// call returns immediately (the frontend then opens the SSE stream to watch
// it — apps/frontend/src/hooks/useSendMessage.ts).
import type { PrismaClient, Workflow } from "@prisma/client";
import { runOrchestrator } from "../agent/orchestrator.js";
import { getProvider } from "../providers/factory.js";

// No auth yet (see REMAINING.md) — every workflow this backend creates is
// attributed to a single fixed dev owner. The mock never modeled ownership
// at all since it has no `ownerId` column; this is the minimal value that
// satisfies the real schema's NOT NULL constraint.
const DEV_OWNER_ID = "dev-user";

// Must match schema.prisma's Conversation.title @default exactly — this is
// how maybeTitleConversation recognizes "never renamed yet" without a
// separate boolean column. apps/frontend/mock/store.ts's identical default
// keeps both backends' behavior in sync.
const DEFAULT_CONVERSATION_TITLE = "New conversation";
const TITLE_MAX_LENGTH = 50;

/**
 * Truncates the first user message into a short, human-scannable
 * conversation title — cheap, no LLM call. Cuts at the last word boundary
 * before the limit (so it doesn't end mid-word) unless that boundary is too
 * close to the start, in which case it hard-cuts rather than producing a
 * near-empty title.
 */
export function deriveTitleFromMessage(content: string): string {
  const cleaned = content.trim().replace(/\s+/g, " ");
  if (cleaned.length <= TITLE_MAX_LENGTH) return cleaned;
  const truncated = cleaned.slice(0, TITLE_MAX_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  const base = lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
  return `${base}…`;
}

/** Renames a conversation from its first message, but only once — a conversation already renamed (or explicitly titled at creation) is left alone. */
async function maybeTitleConversation(
  prisma: PrismaClient,
  conversationId: string,
  content: string,
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { title: true },
  });
  if (conversation?.title !== DEFAULT_CONVERSATION_TITLE) return;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { title: deriveTitleFromMessage(content) },
  });
}

export async function ensureWorkflow(prisma: PrismaClient, conversationId: string): Promise<Workflow> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) throw new Error(`conversation ${conversationId} not found`);

  if (conversation.workflowId) {
    const existing = await prisma.workflow.findUnique({ where: { id: conversation.workflowId } });
    if (existing) return existing;
  }

  const workflow = await prisma.workflow.create({
    data: { name: "Untitled workflow", ownerId: DEV_OWNER_ID },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { workflowId: workflow.id },
  });
  return workflow;
}

export async function startRun(
  prisma: PrismaClient,
  conversationId: string,
  content: string,
): Promise<{ runId: string; messageId: string }> {
  const workflow = await ensureWorkflow(prisma, conversationId);
  await maybeTitleConversation(prisma, conversationId, content);
  const run = await prisma.run.create({ data: { conversationId, status: "pending" } });
  const message = await prisma.message.create({
    data: { conversationId, role: "user", content, runId: run.id },
  });

  const provider = getProvider();
  void runOrchestrator(provider, run.id, conversationId, workflow.id, content).catch((err: unknown) => {
    // eslint-disable-next-line no-console -- fire-and-forget background run; no request context to log through
    console.error("orchestrator run failed unexpectedly", run.id, err);
  });

  return { runId: run.id, messageId: message.id };
}
