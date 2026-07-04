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
//
// Subscribe-before-replay: with live fan-out now riding Redis pub/sub
// (run-channel.ts) instead of an in-process Map, a naive "replay then
// subscribe" order would have a real gap — an event published between the
// replay query and the subscribe call would never reach this client. So
// this handler subscribes FIRST into a buffer, replays from Postgres (the
// unchanged, sole source of truth for anything already persisted), then
// reconciles the buffer against the replay's last-written seq before
// switching to direct live write-through. The frontend's own seq-based
// dedup (apps/frontend/src/stores/run-store.ts) remains an unrelated
// backstop on top of this.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SseEvent } from "@zoft/contract";
import { env } from "../config/env.js";
import { getEventsSince } from "./event-bus.js";
import { subscribeToRun } from "./run-channel.js";

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

  // Phase 1: subscribe immediately, buffering rather than writing, so any
  // event published while replay is in flight isn't lost.
  let live: SseEvent[] = [];
  let buffering = true;
  const onLiveEvent = (evt: SseEvent): void => {
    if (buffering) live.push(evt);
    else if (evt.seq > lastWritten) {
      lastWritten = evt.seq;
      send(evt);
    }
  };
  const unsubscribe = await subscribeToRun(runId, onLiveEvent);

  // Phase 2: replay everything already persisted in Postgres — unchanged
  // source of truth, unaffected by the live subscription above.
  let lastWritten = sinceSeq;
  for (const evt of await getEventsSince(runId, sinceSeq)) {
    send(evt);
    lastWritten = evt.seq;
  }

  // Phase 3: reconcile — flush anything buffered during replay (deduped and
  // ordered by the same seq guard), then switch to direct write-through.
  const buffered = live;
  live = [];
  buffering = false;
  for (const evt of buffered.sort((a, b) => a.seq - b.seq)) {
    if (evt.seq > lastWritten) {
      lastWritten = evt.seq;
      send(evt);
    }
  }

  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ event: "heartbeat", data: {}, seq: 0 })}\n\n`);
  }, 15_000);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    void unsubscribe();
  });
}
