// Three separate Redis connection roles, because ioredis (like Redis itself)
// can't mix them on one socket:
//   - getRedis(): the general-purpose connection — PUBLISH, Lua/atomic ops
//     (redis/seq.ts). Safe to share across the whole process.
//   - createSubscriber(): once a connection issues SUBSCRIBE, it can no
//     longer run other commands — so every SSE stream (runs/sse.ts) needs
//     its OWN dedicated connection, created via .duplicate() and torn down
//     when that stream closes.
//   - getBullConnection(): BullMQ's Queue/Worker constructors want a
//     connection configured with maxRetriesPerRequest: null (BullMQ uses
//     blocking commands that must be allowed to retry indefinitely; ioredis's
//     default retry cap would surface as spurious command failures).
// Named import, not `import IORedis from "ioredis"` — under this repo's
// NodeNext + esModuleInterop setup, ioredis's default export resolves to the
// module namespace rather than the constructable class (the same kind of
// CJS/ESM interop mismatch documented in core/validator.ts for ajv). The
// named `Redis` export is the actual class and doubles as its own type.
import { Redis } from "ioredis";
import { env } from "../config/env.js";

let shared: Redis | undefined;

export function getRedis(): Redis {
  if (!shared) {
    shared = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return shared;
}

/** A fresh connection dedicated to one SUBSCRIBE session. Caller owns its lifecycle — quit() it when the stream closes. */
export function createSubscriber(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

let bullConnection: Redis | undefined;

/**
 * Shared connection for BullMQ Queue/Worker instances. BullMQ duplicates
 * internally as needed for blocking ops.
 *
 * package.json pins our own `ioredis` to the exact version BullMQ bundles
 * (5.10.1) rather than a caret range — with two different resolved copies
 * of the ioredis package, TypeScript treats their `Redis` classes as
 * distinct nominal types (private/protected members don't structurally
 * unify), so a `Redis` instance built from our copy fails to satisfy
 * BullMQ's `ConnectionOptions` even though they're identical at runtime.
 * Pinning the exact version lets pnpm dedupe both to one physical package.
 * If bumping this version, bump it to match whatever bullmq's own
 * `dependencies.ioredis` declares.
 */
export function getBullConnection(): Redis {
  if (!bullConnection) {
    bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return bullConnection;
}
