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
