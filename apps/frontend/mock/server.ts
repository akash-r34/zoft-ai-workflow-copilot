// Standalone dev backend for the frontend. Implements the REST + SSE surface
// documented in Plans/04-api-contract.md against the in-memory store, so the
// UI can be built and demoed with zero dependency on apps/backend (which
// doesn't have its AI/runtime phases yet). Every response is mapped from the
// mock's private storage rows (types.ts) to real @zoft/contract DTOs here at
// the route boundary — the mock never leaks its internal shapes.
import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";
import type {
  ConversationDto,
  CreateRunResponseDto,
  ErrorCode,
  MessageDto,
  SseEvent,
  WorkflowDto,
  WorkflowVersionSummaryDto,
} from "@zoft/contract";
import {
  CreateConversationBodySchema,
  CreateRunBodySchema,
  SimulateStripePaymentBodySchema,
} from "@zoft/contract";
import { runScenario } from "./scenarios.js";
import {
  addMessage,
  createConversation,
  createRun,
  diffVersions,
  ensureWorkflow,
  getConversation,
  getCurrentVersion,
  getEventsSince,
  getNodeDefinitions,
  getRun,
  getVersionByNumber,
  getWorkflow,
  listConversations,
  listMessages,
  listVersions,
  requestCancel,
  restoreVersion,
  subscribe,
} from "./store.js";
import type {
  StoredConversation,
  StoredMessage,
  StoredWorkflow,
  StoredWorkflowVersion,
} from "./types.js";

class ApiErrorException extends Error {
  code: ErrorCode;
  status: number;
  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ── DTO mapping ───────────────────────────────────────────────────────────
function toConversationDto(c: StoredConversation): ConversationDto {
  return {
    id: c.id,
    title: c.title,
    workflowId: c.workflowId,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function toMessageDto(m: StoredMessage): MessageDto {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    runId: m.runId,
    createdAt: m.createdAt,
  };
}

function toWorkflowDto(w: StoredWorkflow): WorkflowDto {
  const current = getCurrentVersion(w.id);
  return {
    id: w.id,
    name: w.name,
    currentVersion: current ? { version: current.version, graph: current.graph } : null,
  };
}

function toVersionSummaryDto(v: StoredWorkflowVersion): WorkflowVersionSummaryDto {
  return {
    version: v.version,
    createdBy: v.createdBy,
    changeSummary: v.changeSummary,
    createdAt: v.createdAt,
  };
}

function toVersionDetailDto(v: StoredWorkflowVersion) {
  return {
    version: v.version,
    graph: v.graph,
    createdBy: v.createdBy,
    changeSummary: v.changeSummary,
    createdAt: v.createdAt,
  };
}

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: "http://localhost:3000",
    allowedHeaders: ["Content-Type", "Last-Event-ID"],
  });

  app.get("/health", async () => ({ ok: true }));

  // ── Conversations ─────────────────────────────────────────────────────
  app.post("/api/conversations", async (request) => {
    const body = CreateConversationBodySchema.parse(request.body ?? {});
    return toConversationDto(createConversation(body.title));
  });

  app.get("/api/conversations", async () => listConversations().map(toConversationDto));

  app.get("/api/conversations/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    if (!getConversation(id))
      throw new ApiErrorException("CONVERSATION_NOT_FOUND", `conversation ${id} not found`, 404);
    return listMessages(id).map(toMessageDto);
  });

  // ── Runs ──────────────────────────────────────────────────────────────
  app.post("/api/conversations/:id/runs", async (request) => {
    const { id } = request.params as { id: string };
    if (!getConversation(id))
      throw new ApiErrorException("CONVERSATION_NOT_FOUND", `conversation ${id} not found`, 404);
    const body = CreateRunBodySchema.parse(request.body);
    const workflow = ensureWorkflow(id);
    const run = createRun(id, workflow.id);
    const message = addMessage({
      conversationId: id,
      role: "user",
      content: body.content,
      runId: run.id,
    });

    void runScenario(run.id, id, workflow.id, body.content).catch((err: unknown) => {
      app.log.error(err, "scenario failed");
    });

    const response: CreateRunResponseDto = { runId: run.id, messageId: message.id };
    return response;
  });

  app.get("/api/runs/:runId/stream", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = getRun(runId);
    if (!run) {
      await reply
        .code(404)
        .send({ error: { code: "RUN_NOT_FOUND", message: `run ${runId} not found` } });
      return;
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const lastEventIdHeader = request.headers["last-event-id"];
    const sinceSeqRaw = typeof lastEventIdHeader === "string" ? Number(lastEventIdHeader) : 0;
    const sinceSeq = Number.isFinite(sinceSeqRaw) ? sinceSeqRaw : 0;

    const send = (evt: SseEvent): void => {
      res.write(`id: ${evt.seq}\n`);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };

    for (const evt of getEventsSince(runId, sinceSeq)) send(evt);

    const unsubscribe = subscribe(runId, send);
    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({ event: "heartbeat", data: {}, seq: 0 })}\n\n`);
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post("/api/runs/:runId/cancel", async (request) => {
    const { runId } = request.params as { runId: string };
    const run = requestCancel(runId);
    if (!run) throw new ApiErrorException("RUN_NOT_FOUND", `run ${runId} not found`, 404);
    return { status: "cancelled" as const };
  });

  // ── Workflows and versions ───────────────────────────────────────────
  app.get("/api/workflows/:id", async (request) => {
    const { id } = request.params as { id: string };
    const workflow = getWorkflow(id);
    if (!workflow)
      throw new ApiErrorException("WORKFLOW_NOT_FOUND", `workflow ${id} not found`, 404);
    return toWorkflowDto(workflow);
  });

  app.get("/api/workflows/:id/versions", async (request) => {
    const { id } = request.params as { id: string };
    if (!getWorkflow(id))
      throw new ApiErrorException("WORKFLOW_NOT_FOUND", `workflow ${id} not found`, 404);
    return listVersions(id).map(toVersionSummaryDto);
  });

  app.get("/api/workflows/:id/versions/:v", async (request) => {
    const { id, v } = request.params as { id: string; v: string };
    const version = getVersionByNumber(id, Number(v));
    if (!version)
      throw new ApiErrorException(
        "WORKFLOW_NOT_FOUND",
        `version ${v} not found for workflow ${id}`,
        404,
      );
    return toVersionDetailDto(version);
  });

  app.get("/api/workflows/:id/diff", async (request) => {
    const { id } = request.params as { id: string };
    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to)
      throw new ApiErrorException(
        "VALIDATION_FAILED",
        "from and to query params are required",
        400,
      );
    const diff = diffVersions(id, Number(from), Number(to));
    if (!diff)
      throw new ApiErrorException("WORKFLOW_NOT_FOUND", "one or both versions not found", 404);
    return diff;
  });

  app.post("/api/workflows/:id/versions/:v/restore", async (request) => {
    const { id, v } = request.params as { id: string; v: string };
    const version = restoreVersion(id, Number(v));
    if (!version)
      throw new ApiErrorException(
        "WORKFLOW_NOT_FOUND",
        `version ${v} not found for workflow ${id}`,
        404,
      );
    return toVersionDetailDto(version);
  });

  // ── Node catalog ──────────────────────────────────────────────────────
  app.get("/api/node-definitions", async (request) => {
    const { query } = request.query as { query?: string };
    return getNodeDefinitions(query);
  });

  // ── Dev stub ──────────────────────────────────────────────────────────
  app.post("/api/dev/simulate/stripe-payment", async (request) => {
    const body = SimulateStripePaymentBodySchema.parse(request.body);
    return { received: true, amount: body.amount, currency: body.currency };
  });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ApiErrorException) {
      void reply.code(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof ZodError) {
      void reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: err.message } });
      return;
    }
    // Fastify's own request-parsing errors (e.g. a stray Content-Type header
    // on a bodyless POST) carry a 4xx statusCode — surface those as client
    // errors instead of masking them as a 500.
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      void reply
        .code(err.statusCode)
        .send({ error: { code: "VALIDATION_FAILED", message: err.message } });
      return;
    }
    app.log.error(err);
    void reply.code(500).send({ error: { code: "INTERNAL", message: err.message } });
  });

  const port = Number(process.env.MOCK_PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
