// Real-database + real-Redis integration test for the run_event durable log
// (event-bus.ts now needs both: Postgres for persistence/replay, Redis for
// seq assignment and live pub/sub). Gated the same way as
// core/__tests__/version-applier.integration.test.ts (see that file's doc
// comment for why RUN_DB_INTEGRATION_TESTS, not DATABASE_URL, is the gate) —
// plus a new RUN_REDIS_INTEGRATION_TESTS flag, since this suite now needs
// both services. Run:
//   docker compose -f infra/docker-compose.yml up -d
//   RUN_DB_INTEGRATION_TESTS=1 RUN_REDIS_INTEGRATION_TESTS=1 \
//     pnpm --filter @zoft/backend test -- event-bus
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { SseEvent } from "@zoft/contract";
import { appendEvent, clearRunState, getEventsSince } from "../event-bus.js";
import { subscribeToRun } from "../run-channel.js";

const RUN_DB_INTEGRATION_TESTS = process.env["RUN_DB_INTEGRATION_TESTS"];
const RUN_REDIS_INTEGRATION_TESTS = process.env["RUN_REDIS_INTEGRATION_TESTS"];
const RUN_ALL = Boolean(RUN_DB_INTEGRATION_TESTS) && Boolean(RUN_REDIS_INTEGRATION_TESTS);

/** Polls until `check()` is true or the timeout elapses — Redis pub/sub delivery is async, unlike the old in-process direct callback it replaced. */
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!check()) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe.skipIf(!RUN_ALL)("event-bus (integration)", () => {
  const prisma = new PrismaClient();
  let runId: string;
  let conversationId: string;

  beforeAll(async () => {
    const conversation = await prisma.conversation.create({ data: {} });
    conversationId = conversation.id;
    const run = await prisma.run.create({ data: { conversationId, status: "running" } });
    runId = run.id;
  });

  afterAll(async () => {
    await clearRunState(runId);
    await prisma.runEvent.deleteMany({ where: { runId } });
    await prisma.run.delete({ where: { id: runId } });
    await prisma.conversation.delete({ where: { id: conversationId } });
    await prisma.$disconnect();
  });

  it("assigns a strictly increasing seq per run, persists each event, and replays them in order", async () => {
    const first = await appendEvent(runId, { event: "run.started", data: { runId } });
    const second = await appendEvent(runId, {
      event: "agent.step",
      data: { kind: "planning", label: "Planning..." },
    });
    const third = await appendEvent(runId, { event: "run.completed", data: { runId } });

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);

    const replayed = await getEventsSince(runId, 0);
    expect(replayed.map((e) => e.event)).toEqual(["run.started", "agent.step", "run.completed"]);
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("getEventsSince only returns events after the given seq (Last-Event-ID replay semantics)", async () => {
    const replayed = await getEventsSince(runId, 1);
    expect(replayed.map((e) => e.event)).toEqual(["agent.step", "run.completed"]);
  });

  it("notifies a live subscriber over Redis pub/sub as events are appended", async () => {
    const received: SseEvent[] = [];
    const unsubscribe = await subscribeToRun(runId, (evt) => received.push(evt));
    await appendEvent(runId, { event: "heartbeat", data: {} });
    await waitUntil(() => received.length > 0);
    await unsubscribe();
    expect(received.map((e) => e.event)).toEqual(["heartbeat"]);
  });

  it("assigns seq atomically across concurrent appendEvent calls (no collisions)", async () => {
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => appendEvent(runId, { event: "heartbeat", data: {} })),
    );
    const seqs = concurrent.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // every seq unique — no collisions
  });
});
