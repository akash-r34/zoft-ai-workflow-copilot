// The durable, replayable SSE event log for a run — the real-backend
// equivalent of apps/frontend/mock/store.ts's appendEvent/getEventsSince/subscribe.
// Every event is persisted to `run_event` (so GET .../stream can replay via
// Last-Event-ID after a restart or reconnect) AND published to this run's
// Redis channel for any live subscriber (any process's SSE handler) to pick up.
//
// seq assignment and live fan-out both moved to Redis (redis/seq.ts,
// runs/run-channel.ts) so multiple backend processes can serve the same
// run correctly — replacing the in-memory Map-based versions of both that
// only worked for a single process. Postgres persistence (this file's
// appendEvent/getEventsSince) is unchanged and remains the sole replay source.
import type { Prisma } from "@prisma/client";
import type { SseEvent } from "@zoft/contract";
import { prisma } from "../db/prisma.js";
import { dropSeq, nextSeq } from "../redis/seq.js";
import { publishRunEvent } from "./run-channel.js";

// Distributes Omit<_, "seq"> over the SseEvent union so authoring an event
// still requires the correct `data` shape for its `event` discriminant — see
// apps/frontend/mock/store.ts's identical OmitSeq trick.
type OmitSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
export type SseEventInput = OmitSeq<SseEvent>;

export async function appendEvent(runId: string, input: SseEventInput): Promise<SseEvent> {
  const seq = await nextSeq(runId);

  await prisma.runEvent.create({
    data: {
      runId,
      seq,
      type: input.event,
      payload: input as unknown as Prisma.InputJsonValue,
    },
  });

  // Safe by construction: `input` is exactly SseEvent minus `seq`; adding
  // `seq` back reconstructs a valid discriminated-union member.
  const full = { ...input, seq } as SseEvent;
  await publishRunEvent(runId, full);
  return full;
}

export async function getEventsSince(runId: string, sinceSeq: number): Promise<SseEvent[]> {
  const rows = await prisma.runEvent.findMany({
    where: { runId, seq: { gt: sinceSeq } },
    orderBy: { seq: "asc" },
  });
  return rows.map((r) => ({ ...(r.payload as Record<string, unknown>), seq: r.seq }) as SseEvent);
}

/** Drops the Redis seq key for a run once it's terminal — call after run.completed/failed/cancelled/timeout. */
export async function clearRunState(runId: string): Promise<void> {
  await dropSeq(runId);
}
