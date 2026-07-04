# 08 — The API Server, Run Lifecycle, and Real-Time Delivery

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend. For the
> full endpoint-by-endpoint and event-by-event reference table, see `../api.md` — this
> chapter explains the *code paths*, not a restated table of routes.

## Boot sequence

```ts
// apps/backend/src/index.ts (full file, 14 lines)
import { buildApp } from "./app.js";
import { env } from "./config/env.js";

const start = async (): Promise<void> => {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
```

`index.ts` only boots and listens. `app.ts`'s `buildApp` (`app.ts:15-35`) does everything
else — deliberately kept separate so tests can build an app instance and use Fastify's
`app.inject()` to make in-process requests without ever binding a real port:

```ts
// apps/backend/src/app.ts:15-35 (full function)
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    allowedHeaders: ["Content-Type", "Last-Event-ID"],
  });

  registerErrorHandler(app);
  registerHealthRoute(app);
  registerConversationRoutes(app);
  registerRunRoutes(app);
  registerWorkflowRoutes(app);
  registerNodeDefinitionRoutes(app);
  registerDevRoutes(app);

  return app;
}
```

Note the CORS `allowedHeaders` explicitly includes `Last-Event-ID` (`app.ts:23`) — the
frontend's SSE client sends this on reconnect to resume from where it left off, and a
browser silently blocks the request if the server doesn't explicitly allow that header.

## Route modules — one file per resource

| File | Routes | What it does |
|---|---|---|
| `routes/health.ts` (5 lines) | `GET /health` | Liveness check, `{ ok: true }` |
| `routes/conversations.ts` (48) | `POST/GET /api/conversations`, `GET .../messages`, `POST .../runs` | Chat sessions + kicks off a run |
| `routes/runs.ts` (137) | `GET .../stream`, `POST .../cancel`, `.../approve`, `.../reject` | The run lifecycle + approval gate (`03-the-core-invariant.md`) |
| `routes/workflows.ts` (94) | `GET /api/workflows/:id`, `.../versions`, `.../versions/:v`, `.../diff`, `POST .../restore` | Workflow + version history reads, restore |
| `routes/node-definitions.ts` (15) | `GET /api/node-definitions` | Node catalog search (same `searchCatalog` the agent's `search_nodes` tool falls back to) |
| `routes/dev.ts` (14) | `POST /api/dev/simulate/stripe-payment` | Acknowledgement-only stub — doesn't yet trigger a real run (`REMAINING.md`) |
| `routes/errors.ts` (38) | (no routes — the error handler) | Turns any thrown error into the `{ error: { code, message } }` envelope |

Every route handler follows the same shape: parse params/body (Zod schemas from
`@zoft/contract`, `05-contract-package.md`), look up rows via the shared `prisma` client
(`db/prisma.ts`), throw `ApiErrorException` on a domain error, and either return a DTO
object directly (Fastify serializes the return value) or hand off to `runs/sse.ts` for the
one streaming route.

### `routes/conversations.ts` — where a run actually starts

```ts
// apps/backend/src/routes/conversations.ts:39-47
app.post("/api/conversations/:id/runs", async (request): Promise<CreateRunResponseDto> => {
  const { id } = request.params as { id: string };
  const conversation = await prisma.conversation.findUnique({ where: { id } });
  if (!conversation) throw new ApiErrorException("CONVERSATION_NOT_FOUND", `conversation ${id} not found`, 404);
  const body = CreateRunBodySchema.parse(request.body);
  return startRun(prisma, id, body.content);
});
```

This route is a thin wrapper — all the actual logic is in `runs/run-service.ts`'s
`startRun` (below). Notice it returns immediately: `{ runId, messageId }`
(`CreateRunResponseDto`, `05-contract-package.md`), not the run's eventual result. The
frontend gets this response, then separately opens the SSE stream to watch the run play out
(`10-frontend.md`'s `useSendMessage`/`useRunStream`).

### `runs/run-service.ts` — `startRun` and the fire-and-forget orchestrator launch

```ts
// apps/backend/src/runs/run-service.ts:75-94
export async function startRun(prisma, conversationId, content): Promise<{ runId: string; messageId: string }> {
  const workflow = await ensureWorkflow(prisma, conversationId);
  await maybeTitleConversation(prisma, conversationId, content);
  const run = await prisma.run.create({ data: { conversationId, status: "pending" } });
  const message = await prisma.message.create({ data: { conversationId, role: "user", content, runId: run.id } });

  const provider = getProvider();
  void runOrchestrator(provider, run.id, conversationId, workflow.id, content).catch((err) => {
    console.error("orchestrator run failed unexpectedly", run.id, err);
  });

  return { runId: run.id, messageId: message.id };
}
```

Three things worth noticing:
- **`ensureWorkflow`** (`run-service.ts:56-73`) creates a `Workflow` row the first time a
  conversation needs one — every workflow's `ownerId` is hardcoded to `"dev-user"`
  (`run-service.ts:14`) since there's no auth layer yet.
- **`maybeTitleConversation`** (`run-service.ts:40-54`) auto-renames a still-default-titled
  conversation from its first message — `deriveTitleFromMessage`
  (`run-service.ts:30-37`) is a cheap string truncation (cut at the last word boundary
  before 50 chars), explicitly **not an LLM call**.
- **`void runOrchestrator(...)`** — the agent loop (`07-agent-and-providers.md`) is launched
  and *not awaited*. The `.catch(...)` is a safety net for truly unexpected exceptions (the
  orchestrator's own contract is "never throws — every failure path emits a terminal SSE
  event," `orchestrator.ts:73`'s doc comment); this catch only fires if that contract is
  somehow violated. The REST call returns `{ runId, messageId }` before the orchestrator has
  necessarily done anything — that's why the SSE stream exists.

### `routes/runs.ts` — stream, cancel, approve, reject

Covered in detail in `03-the-core-invariant.md` (approve/reject) and below (stream). One
route worth calling out here: `POST .../cancel` (`routes/runs.ts:33-39`) does nothing more
than set `Run.cancelRequested = true` — the actual stopping happens inside the orchestrator's
next `tick()` call (`07-agent-and-providers.md`).

## `routes/errors.ts` — one error handler for every route

```ts
// apps/backend/src/routes/errors.ts:18-38
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ApiErrorException) {
      void reply.code(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof ZodError) {
      void reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: err.message } });
      return;
    }
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      void reply.code(err.statusCode).send({ error: { code: "VALIDATION_FAILED", message: err.message } });
      return;
    }
    app.log.error(err);
    void reply.code(500).send({ error: { code: "INTERNAL", message: err.message } });
  });
}
```

Every route handler can just `throw new ApiErrorException("WORKFLOW_NOT_FOUND", "...", 404)`
(`ApiErrorException`, `errors.ts:8-16`) and never worry about response formatting — this one
handler is the only place that turns an exception into the contract's error envelope
(`05-contract-package.md`'s `ErrorEnvelope`). A Zod parse failure from a malformed request
body is automatically a 400 `VALIDATION_FAILED`, not a 500, without any per-route try/catch.

## Real-time delivery: how one event gets from the orchestrator to the browser

This is the part of the system that changed the most in the Phase 2/3 → Redis-backed
upgrade — worth understanding in full, since it's the piece most likely to matter if you
ever scale the backend beyond one process.

```
agent/orchestrator.ts
   │  appendEvent(runId, { event: "...", data: {...} })
   ▼
runs/event-bus.ts (appendEvent)
   │  1. seq = await nextSeq(runId)          <- redis/seq.ts, atomic
   │  2. INSERT INTO run_event (Postgres)     <- sole replay source, unchanged
   │  3. publishRunEvent(runId, event)        <- run-channel.ts, Redis PUBLISH
   ▼
runs/run-channel.ts (Redis pub/sub channel "run:{runId}")
   ▼
runs/sse.ts (subscribeToRun callback, in whichever process is holding the client's connection)
   │  writes `id: {seq}\ndata: {...}\n\n` to the open HTTP response
   ▼
Browser (EventSource) -> apps/frontend/src/lib/sse.ts -> run-store.ts
```

### `redis/seq.ts` — one atomic counter per run, race-free across processes

```ts
// apps/backend/src/redis/seq.ts:18-23 (the Lua script)
const SEED_AND_INCR_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
end
return redis.call("INCR", KEYS[1])
`;
```

```ts
// apps/backend/src/redis/seq.ts:35-51 (nextSeq)
export async function nextSeq(runId: string): Promise<number> {
  let seed = 0;
  if (!seededRuns.has(runId)) {
    const agg = await prisma.runEvent.aggregate({ where: { runId }, _max: { seq: true } });
    seed = agg._max.seq ?? 0;
    seededRuns.add(runId);
  }
  const redis = getRedis();
  const result = await redis.eval(SEED_AND_INCR_SCRIPT, 1, seqKey(runId), String(seed), String(SEQ_KEY_TTL_SECONDS));
  return Number(result);
}
```

The key insight (the file's own header comment, `seq.ts:1-12`): a run's Redis counter only
needs seeding from Postgres's existing `max(seq)` **once** — after that, Redis alone is
authoritative and a plain `INCR` is race-free across any number of processes. The Lua script
makes "seed if absent, then increment" one atomic round trip via `EVAL`, so two processes
racing to seed the same brand-new run's key can't double-seed: whichever `SET` lands first
wins, and the loser's `EXISTS` check simply finds the key already there. `seededRuns`
(`seq.ts:33`) is a process-local `Set` used purely to skip the Postgres query on repeat
calls within one process — it's an optimization, never relied on for correctness (a cache
miss just means re-checking Postgres, which is still safe). This replaces what used to be a
plain in-memory `Map<runId, number>` — safe only because exactly one process ever emitted
events for a given run; that assumption breaks the moment you run two backend replicas.

### `runs/run-channel.ts` — the pub/sub transport

```ts
// apps/backend/src/runs/run-channel.ts:13-15
export async function publishRunEvent(runId: string, evt: SseEvent): Promise<void> {
  await getRedis().publish(channelFor(runId), JSON.stringify(evt));
}
```

```ts
// apps/backend/src/runs/run-channel.ts:18-40 (subscribeToRun, abridged)
export async function subscribeToRun(runId, onEvent): Promise<() => Promise<void>> {
  const subscriber = createSubscriber();   // a DEDICATED connection — see redis/connection.ts
  subscriber.on("message", (ch, message) => { if (ch === channel) onEvent(JSON.parse(message)); });
  await subscriber.subscribe(channel);
  return async () => { await subscriber.unsubscribe(channel); await subscriber.quit(); };
}
```

Every SSE stream gets its own dedicated Redis connection via `createSubscriber()`
(`redis/connection.ts:31-33`) — once an ioredis connection issues `SUBSCRIBE`, it can't run
any other command, so it can't be the shared general-purpose connection `getRedis()`
returns. `getRedis()`, `createSubscriber()`, and `getBullConnection()`
(`redis/connection.ts`, 56 lines total) are three separate connection roles for exactly this
reason — see that file's header comment for all three.

### `runs/event-bus.ts` — persist to Postgres, publish to Redis

```ts
// apps/backend/src/runs/event-bus.ts:24-41
export async function appendEvent(runId: string, input: SseEventInput): Promise<SseEvent> {
  const seq = await nextSeq(runId);
  await prisma.runEvent.create({ data: { runId, seq, type: input.event, payload: input } });
  const full = { ...input, seq } as SseEvent;
  await publishRunEvent(runId, full);
  return full;
}
```

Postgres stays the **sole source of truth for replay** — nothing about the Redis migration
changed that. `getEventsSince` (`event-bus.ts:43-49`) is still a plain `run_event` query by
`seq`. Redis only carries the *live* tail for whichever process happens to be holding an
open SSE connection right now.

### `runs/sse.ts` — subscribe before replay, then reconcile

This is the trickiest piece of the whole real-time system, and the file's own header
comment (`sse.ts:18-27`) explains exactly why the ordering matters: with live fan-out riding
Redis pub/sub instead of an in-process object, a naive "replay from Postgres, *then*
subscribe to live" order has a real gap — an event published in between would never reach
this client. So the handler does the opposite order and reconciles:

```ts
// apps/backend/src/runs/sse.ts:56-87 (the three phases, abridged)
// Phase 1: subscribe immediately, buffering rather than writing.
let live: SseEvent[] = [];
let buffering = true;
const onLiveEvent = (evt) => { if (buffering) live.push(evt); else if (evt.seq > lastWritten) { lastWritten = evt.seq; send(evt); } };
const unsubscribe = await subscribeToRun(runId, onLiveEvent);

// Phase 2: replay everything already persisted in Postgres.
let lastWritten = sinceSeq;
for (const evt of await getEventsSince(runId, sinceSeq)) { send(evt); lastWritten = evt.seq; }

// Phase 3: reconcile — flush anything buffered during replay, deduped by seq, then live write-through.
const buffered = live; live = []; buffering = false;
for (const evt of buffered.sort((a, b) => a.seq - b.seq)) {
  if (evt.seq > lastWritten) { lastWritten = evt.seq; send(evt); }
}
```

The `evt.seq > lastWritten` guard, applied identically in both the buffer-flush and the
live-write-through closure, is what makes this exact rather than approximate: any event that
arrived both via the Postgres replay query *and* via the live buffer (because it was
persisted and published in the small window before the subscription was active) is only
ever sent once. This was verified with a genuine two-process test: two backend instances on
different ports, one running the orchestrator, an SSE client connected to the *other* one —
confirming every event arrives with `seq` strictly monotonic across the whole run.

The route handler itself uses `reply.hijack()` (`sse.ts:35`) to take the raw HTTP response
over from Fastify — which is also why `Access-Control-Allow-Origin` is set by hand in the
`writeHead` call (`sse.ts:37-44`): Fastify's own CORS plugin only stages headers on the
Fastify `reply` object, and hijacking bypasses that pipeline entirely. This was a real bug
found via browser-driven Playwright testing (not typecheck/lint/unit tests — CORS failures
are invisible to all three), documented in the file's own comment (`sse.ts:6-16`) and in
`REMAINING.md`'s history.

`Last-Event-ID` (`sse.ts:47-49`) is what makes reconnection resumable: the browser's native
`EventSource` automatically resends the last `id:` it saw as this header on reconnect, and
the handler uses it as `sinceSeq` for the Postgres replay — no custom reconnection logic
needed on the frontend beyond what `EventSource` already does (`10-frontend.md`).

## `dto/` — turning Prisma rows into contract DTOs

`dto/mappers.ts` (76 lines) and `dto/diff.ts` (36 lines) are the thin translation layer
between what Prisma returns and what `packages/contract` promises callers. `diffGraphs`
(`dto/diff.ts:8-32`) computes a `WorkflowDiff` by comparing two graphs' node/edge ids (added
= in `after` but not `before`, removed = the reverse, changed = same id but
`JSON.stringify`-different `config`) — it's used both by `workflow.proposed`/`workflow.
updated` SSE payloads (`agent/orchestrator.ts`) and by `GET /api/workflows/:id/diff`
(`routes/workflows.ts:43-65`). It was ported from `apps/frontend/mock/graph-ops.ts`
specifically so both backends produce byte-identical diff shapes (`11-mock-backend.md`).

## `config/env.ts` — one validated source of truth for runtime config

```ts
// apps/backend/src/config/env.ts:65-75
function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}

export const env: Env = loadEnv();
```

Every module reads config through this `env` object, never `process.env` directly — a
missing or malformed variable fails fast at boot instead of surfacing three layers deep in
the agent loop. See `14-ops-and-docker.md` for the full table of every variable, its
default, and which module reads it.

---
**Prev:** [`07-agent-and-providers.md`](./07-agent-and-providers.md) · **Next:**
[`09-workers.md`](./09-workers.md) · **Related:**
[`../api.md`](../api.md), [`10-frontend.md`](./10-frontend.md),
[`12-end-to-end-trace.md`](./12-end-to-end-trace.md)
