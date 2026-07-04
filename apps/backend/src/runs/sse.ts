// GET /api/runs/:runId/stream handler. Byte-compatible with
// apps/frontend/mock/server.ts's stream route (same framing, same
// Last-Event-ID replay, same 15s heartbeat) so apps/frontend/src/lib/sse.ts
// needs no changes to talk to the real backend.
//
// `reply.hijack()` takes the raw response over from Fastify entirely, which
// means Fastify's own send pipeline — including @fastify/cors's onRequest
// hook, which only stages headers on the Fastify reply object, not the raw
// node response — never runs for this route. Without
// Access-Control-Allow-Origin set explicitly here, a real cross-origin
// browser (the frontend on :3000 talking to this backend on :3001) blocks
// the stream outright with a CORS error, even though every other route
// works fine. Caught via real Playwright-driven browser testing, not
// typecheck/lint/unit tests — see REMAINING.md's "known simplifications"
// note and PHASE4_5_DONE.md for the precedent (the mock had this exact bug
// too; both are now fixed).
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SseEvent } from "@zoft/contract";
import { env } from "../config/env.js";
import { getEventsSince, subscribe } from "./event-bus.js";

export async function streamRun(request: FastifyRequest, reply: FastifyReply, runId: string): Promise<void> {
  void reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": env.CORS_ORIGIN,
    Vary: "Origin",
  });
  res.write(": connected\n\n");

  const lastEventIdHeader = request.headers["last-event-id"];
  const sinceSeqRaw = typeof lastEventIdHeader === "string" ? Number(lastEventIdHeader) : 0;
  const sinceSeq = Number.isFinite(sinceSeqRaw) ? sinceSeqRaw : 0;

  const send = (evt: SseEvent): void => {
    res.write(`id: ${evt.seq}\n`);
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  for (const evt of await getEventsSince(runId, sinceSeq)) send(evt);

  const unsubscribe = subscribe(runId, send);
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ event: "heartbeat", data: {}, seq: 0 })}\n\n`);
  }, 15_000);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
