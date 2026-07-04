// The durable, replayable SSE event log for a run — the real-backend
// equivalent of apps/frontend/mock/store.ts's appendEvent/getEventsSince/subscribe.
// Every event is persisted to `run_event` (so GET .../stream can replay via
// Last-Event-ID after a restart or reconnect) AND pushed synchronously to any
// live in-process subscriber (the SSE handler for this run, if one is open).
//
// Known simplification (documented in REMAINING.md): `seq` is assigned from
// an in-memory per-run counter, safe because exactly one orchestrator ever
// emits events for a given run and every emit is awaited before the next is
// issued (no concurrent writers for the same runId within a process). A
// multi-instance deployment would need this to be a DB-transactional or
// Redis-atomic counter instead — that's the same Redis pub/sub bridge work
// listed as deferred Phase 3 infrastructure.
import type { Prisma } from "@prisma/client";
import type { SseEvent } from "@zoft/contract";
import { prisma } from "../db/prisma.js";

// Distributes Omit<_, "seq"> over the SseEvent union so authoring an event
// still requires the correct `data` shape for its `event` discriminant — see
// apps/frontend/mock/store.ts's identical OmitSeq trick.
type OmitSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
export type SseEventInput = OmitSeq<SseEvent>;

const seqCounters = new Map<string, number>();
const subscribers = new Map<string, Set<(evt: SseEvent) => void>>();

async function currentSeq(runId: string): Promise<number> {
  const cached = seqCounters.get(runId);
  if (cached !== undefined) return cached;
  const agg = await prisma.runEvent.aggregate({ where: { runId }, _max: { seq: true } });
  const seq = agg._max.seq ?? 0;
  seqCounters.set(runId, seq);
  return seq;
}

export async function appendEvent(runId: string, input: SseEventInput): Promise<SseEvent> {
  const nextSeq = (await currentSeq(runId)) + 1;
  seqCounters.set(runId, nextSeq);

  await prisma.runEvent.create({
    data: {
      runId,
      seq: nextSeq,
      type: input.event,
      payload: input as unknown as Prisma.InputJsonValue,
    },
  });

  // Safe by construction: `input` is exactly SseEvent minus `seq`; adding
  // `seq` back reconstructs a valid discriminated-union member.
  const full = { ...input, seq: nextSeq } as SseEvent;
  notify(runId, full);
  return full;
}

export async function getEventsSince(runId: string, sinceSeq: number): Promise<SseEvent[]> {
  const rows = await prisma.runEvent.findMany({
    where: { runId, seq: { gt: sinceSeq } },
    orderBy: { seq: "asc" },
  });
  return rows.map((r) => ({ ...(r.payload as Record<string, unknown>), seq: r.seq }) as SseEvent);
}

export function subscribe(runId: string, listener: (evt: SseEvent) => void): () => void {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

function notify(runId: string, evt: SseEvent): void {
  const set = subscribers.get(runId);
  if (!set) return;
  for (const listener of set) listener(evt);
}

/** Drops the in-memory seq counter and subscriber set for a run once it's terminal — call after run.completed/failed/cancelled/timeout to avoid an unbounded Map. */
export function clearRunState(runId: string): void {
  seqCounters.delete(runId);
  subscribers.delete(runId);
}
