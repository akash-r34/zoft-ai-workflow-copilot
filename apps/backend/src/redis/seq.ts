// Atomic, cross-process seq assignment for a run's SSE event log — replaces
// runs/event-bus.ts's old in-memory `Map<runId, number>` counter, which was
// only safe because exactly one process ever emitted for a given run.
//
// The key insight: a run's seq key only needs "seeding" from Postgres's
// existing max(seq) ONCE — after that, Redis alone is authoritative and an
// atomic INCR is race-free across any number of processes. The Lua script
// makes "seed if absent, then increment" a single atomic round trip, so two
// processes racing to seed the same brand-new run's key can't double-seed:
// whichever arrives first wins the SET, the loser's (unused) seed argument
// is simply ignored because the key already exists by the time its script
// invocation runs.
import { prisma } from "../db/prisma.js";
import { getRedis } from "./connection.js";

const SEQ_KEY_TTL_SECONDS = 60 * 60 * 24; // 24h safety net against leaked keys for abandoned runs

const SEED_AND_INCR_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
end
return redis.call("INCR", KEYS[1])
`;

function seqKey(runId: string): string {
  return `run:${runId}:seq`;
}

// Process-local memoization only — purely an optimization to skip the
// Postgres seed query on every call within one process's lifetime. Never
// relied on for correctness: see the module doc above for why a cache miss
// (e.g. a different process, or this one restarted) is still race-free.
const seededRuns = new Set<string>();

export async function nextSeq(runId: string): Promise<number> {
  let seed = 0;
  if (!seededRuns.has(runId)) {
    const agg = await prisma.runEvent.aggregate({ where: { runId }, _max: { seq: true } });
    seed = agg._max.seq ?? 0;
    seededRuns.add(runId);
  }
  const redis = getRedis();
  const result = await redis.eval(
    SEED_AND_INCR_SCRIPT,
    1,
    seqKey(runId),
    String(seed),
    String(SEQ_KEY_TTL_SECONDS),
  );
  return Number(result);
}

/** Drops the local memoization and the Redis key — call once a run reaches a terminal state. */
export async function dropSeq(runId: string): Promise<void> {
  seededRuns.delete(runId);
  await getRedis().del(seqKey(runId));
}
