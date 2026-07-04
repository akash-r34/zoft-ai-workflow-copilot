// Real-database integration test for the run_event durable log, gated the
// same way as core/__tests__/version-applier.integration.test.ts (see that
// file's doc comment for why RUN_DB_INTEGRATION_TESTS, not DATABASE_URL, is
// the gate). Run:
//   docker compose -f infra/docker-compose.yml up -d
//   RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @zoft/backend test -- event-bus
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { appendEvent, clearRunState, getEventsSince, subscribe } from "../event-bus.js";

const RUN_DB_INTEGRATION_TESTS = process.env["RUN_DB_INTEGRATION_TESTS"];

describe.skipIf(!RUN_DB_INTEGRATION_TESTS)("event-bus (integration)", () => {
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
    clearRunState(runId);
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

  it("notifies a live subscriber synchronously as events are appended", async () => {
    const received: string[] = [];
    const unsubscribe = subscribe(runId, (evt) => received.push(evt.event));
    await appendEvent(runId, { event: "heartbeat", data: {} });
    unsubscribe();
    expect(received).toEqual(["heartbeat"]);
  });
});
