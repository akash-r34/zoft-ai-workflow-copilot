# 11 — The Mock Backend

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

`apps/frontend/mock/` (1,593 lines across 7 files) is a **second, independent
implementation** of the exact same REST + SSE contract the real backend
(`apps/backend`) implements. It is not a test double or a thin stub — it's a full Fastify
server with its own in-memory (disk-snapshotted) store and its own scripted "AI." This
chapter exists so you never confuse the two while reading code, and so you know when to
reach for which.

## Why it exists at all

Per `CLAUDE.md`'s build-phases table, the frontend (Phases 4–5) was built **before** the
real backend's AI/runtime phases (Phase 2–3) landed. To build and demo the chat UI, the
graph visualization, the approval gate, and all five failure states without waiting on a
real agent loop, the project built this mock first — a standalone dev backend implementing
`packages/contract`'s REST + SSE surface against an in-memory store, with a keyword-scripted
"AI" standing in for a real one. Once the real backend was built, **the mock was kept, not
deleted** — it remains a faithful, independently-maintained peer implementation, useful for
frontend development and demos that don't need a database or Redis running at all.

```
apps/frontend/mock/
  server.ts       (380)  Fastify app — every route, byte-compatible with apps/backend's
  store.ts        (347)  In-memory store + disk snapshot persistence
  scenarios.ts    (593)  The scripted "AI" — same 6-scenario keyword engine idea as MockProvider
  catalog.ts      (108)  The same 5-node catalog, hardcoded here instead of seeded via Prisma
  graph-ops.ts     (63)  makeNode/makeEdge/cloneGraph/diffGraphs — pure graph helpers
  persistence.ts   (27)  Reads/writes a gitignored .data.json snapshot file
  types.ts         (75)  The mock's own internal storage row types (never exposed past the route boundary)
```

Run it with `pnpm --filter @zoft/frontend mock` (check `apps/frontend/mock/package.json`
for the exact script name) — it listens on the same port (`3001`) the real backend uses, so
the frontend's `NEXT_PUBLIC_API_URL` doesn't need to change to switch between them.

## How it differs from the real backend — the important distinctions

| | Real backend (`apps/backend`) | Mock (`apps/frontend/mock`) |
|---|---|---|
| Storage | Postgres via Prisma | In-memory objects, snapshotted to a gitignored `.data.json` file (`persistence.ts`) |
| The "AI" | `MockProvider` drives the **real** agent loop (`agent/orchestrator.ts`), which calls the **real** tool registry and the **real** `core/validator.ts` | `scenarios.ts`'s `runScenario` directly emits scripted SSE events **and directly mutates the store** — there is no separate validator or tool-registry layer to go through |
| Real-time delivery | Redis pub/sub + atomic seq (`08-api-and-runs.md`) | An in-process `Map<runId, Set<listener>>` (`store.ts:316-334`'s `subscribers`/`notify`) — fine for a single process, which is all the mock ever runs as |
| The core invariant | Enforced by actual separate modules: `tools/propose-operations.ts` validates, `tools/commit.ts`/`core/version-applier.ts` writes | **Not separately enforced as code** — `scenarios.ts` computes a candidate graph directly and calls `store.ts`'s `appendVersion` on approval. The mock is trusted to *behave* consistently with the invariant (propose then pause then write-on-approve) without a validator object separating those concerns in code. |
| Background workers | Real BullMQ workers (`09-workers.md`) | None — no embeddings, no validation sweep, no archival |
| Approval gate | `Run.proposedOps`/`proposedGraph`/`proposalStatus` columns (`04-data-model.md`) | `StoredRun.proposedGraph`/`proposalSummary`/`proposalStatus` fields — same idea, same field names even, just in-memory |

**The most important distinction to internalize**: the mock's scenario engine directly
mutates a `WorkflowGraph` and hands it to `store.ts`'s `appendVersion` — it does **not**
route through anything resembling `core/applier.ts`/`core/validator.ts`. This is fine for
the mock's purpose (demoing UI behavior, not testing backend safety), but if you ever find
yourself reading `scenarios.ts` looking for "the validator," there isn't one — that's the
real backend's job (`06-deterministic-core.md`), deliberately not duplicated here.

## `server.ts` — route-for-route parity with `apps/backend`

```ts
// apps/frontend/mock/server.ts:1-6 (file header)
// Standalone dev backend for the frontend. Implements the REST + SSE surface
// documented in Plans/04-api-contract.md against the in-memory store, so the
// UI can be built and demoed with zero dependency on apps/backend...
```

Every route the real backend has, this file also has, at the same path, returning the same
DTO shapes: `POST/GET /api/conversations`, `.../messages`, `.../runs`,
`GET /api/runs/:runId/stream`, `POST .../cancel`/`.../approve`/`.../reject`,
`GET /api/workflows/:id`(`+/versions`,`+/versions/:v`,`+/diff`),
`POST .../versions/:v/restore`, `GET /api/node-definitions`,
`POST /api/dev/simulate/stripe-payment`. Compare `server.ts:132-349` against
`apps/backend/src/routes/*.ts` (`08-api-and-runs.md`) — the handler bodies differ (calling
`store.ts` functions instead of Prisma), but the request/response shapes are identical,
because both sides import the same `@zoft/contract` types and the mock maps its own
internal `StoredX` row shapes to real DTOs at the route boundary (`server.ts:71-119`'s
`toConversationDto`/`toMessageDto`/`toWorkflowDto`/etc. — "the mock never leaks its internal
shapes," `server.ts:6`'s comment) — this is exactly why `apps/frontend/src/lib/api.ts`
(`10-frontend.md`) needs zero changes to talk to either backend.

The SSE route (`server.ts:170-218`) has the **exact same `reply.hijack()` +
`Access-Control-Allow-Origin` fix** the real backend's `runs/sse.ts` has
(`08-api-and-runs.md`) — the file comment at `server.ts:182-187` even cross-references
`PHASE4_5_DONE.md` as precedent: this CORS bug was found and fixed *here first*, then the
identical fix was applied to the real backend when it was built. One difference: the mock's
stream doesn't need the real backend's subscribe-before-replay reconciliation
(`08-api-and-runs.md`) — since everything lives in one process with an in-memory `Map`,
there's no cross-process gap to close; it simply replays then subscribes
(`server.ts:207-209`).

## `store.ts` — the in-memory database

```ts
// apps/frontend/mock/store.ts:299-309 (appendEvent — compare to the real backend's version)
export function appendEvent(runId: string, input: SseEventInput): SseEvent {
  const events = getOrCreateEventsArray(runId);
  const seq = events.length + 1;
  const full = { ...input, seq } as SseEvent;
  events.push(full);
  persist();
  notify(runId, full);
  return full;
}
```

Compare this directly to `apps/backend/src/runs/event-bus.ts`'s `appendEvent`
(`08-api-and-runs.md`) — same shape, same `OmitSeq<SseEvent>` trick
(`store.ts:21-25`, identical to the real backend's), but `seq` here is just
`events.length + 1` against a plain array, and `notify` (`store.ts:330-334`) is a
synchronous in-process fan-out to a `Map<runId, Set<listener>>` instead of a Redis publish.
This is correct specifically *because* the mock only ever runs as one process — the moment
you'd need two mock instances serving the same run, this in-memory approach would need the
same Redis-based redesign the real backend went through (`08-api-and-runs.md`'s
`redis/seq.ts`/`run-channel.ts` chapter) — nobody has needed that for a dev-only tool.

`store.ts` also has its own `deriveTitleFromMessage`/`maybeTitleConversation`
(`store.ts:90-105`) — **deliberately kept byte-identical** to
`apps/backend/src/runs/run-service.ts`'s version (`08-api-and-runs.md`), down to the same
`DEFAULT_CONVERSATION_TITLE`/`TITLE_MAX_LENGTH` constants, so conversation auto-titling
behaves the same regardless of which backend is running.

### `persistence.ts` — why the mock survives a restart

```ts
// apps/frontend/mock/persistence.ts (full file, 27 lines)
export function loadSnapshot<T>(): T | undefined {
  if (!existsSync(DATA_FILE)) return undefined;
  try { return JSON.parse(readFileSync(DATA_FILE, "utf-8")) as T; } catch { return undefined; }
}

export function saveSnapshot(data: unknown): void {
  try { writeFileSync(DATA_FILE, JSON.stringify(data), "utf-8"); } catch { /* best-effort */ }
}
```

Every mutating `store.ts` function ends with a call to `persist()`
(a thin wrapper around `saveSnapshot`, `store.ts:40-42`), writing the whole snapshot to a
gitignored `.data.json` file (`apps/frontend/mock/.data.json`, visible in the source tree —
it's the mock's actual "database" on disk). This is what makes "kill the mock mid-run,
restart it, the SSE stream resumes with no gaps" a meaningful test — the file's own header
comment (`persistence.ts:1-4`) calls this out directly: "a real backend gets this from
Postgres; this mock gets it from a gitignored JSON file."

## `scenarios.ts` — the mock's scripted "AI"

```ts
// apps/frontend/mock/scenarios.ts:1-7 (file header)
// The mock's deterministic "AI". No LLM call here — a keyword match on the
// user's message picks a scripted sequence of SSE events (with realistic
// pacing) that mirrors what the real agent loop in apps/backend/src/agent/
// orchestrator.ts emits: plan -> search nodes -> read schema -> validate ->
// propose -> (pause for human approval, PRD v1.1 Decision #1) -> commit.
```

This is the conceptual sibling of `apps/backend/src/providers/mock-provider.ts`
(`07-agent-and-providers.md`) — both are keyword-driven scripted engines covering the same
demo scenarios (build, explain, self-correct, fail, provider-switch, tool-failure, timeout)
— but they operate at different layers. `MockProvider` yields `ProviderDelta` values that
drive the **real** orchestrator, which calls the **real** tool registry and validator.
`scenarios.ts`'s `runScenario` instead directly calls `store.appendEvent` for every SSE
event and directly computes/stores graphs — there's no intermediate "propose" tool call
that a separate validator checks. Its helper functions parallel `MockProvider`'s almost
exactly (same regex-driven keyword detection, e.g. `parseAmount`,
`slackConfig`/`teamsConfig`, `insertAfterTrigger` — compare `scenarios.ts:75-86` and
`scenarios.ts:114-onward` to `mock-provider.ts:23-34,43-56`), which is deliberate: the two
were built to feel identical from the outside even though their internals differ.

`tick` (`scenarios.ts:26-34`) and `runToolCall` (`scenarios.ts:48-68`) are this file's
equivalent of `agent/orchestrator.ts`'s `tick`/`handleDelta` pacing — same idea (small
delays between steps so the timeline streams visibly, and a cancellation checkpoint at each
one), reimplemented here rather than shared, since the two codebases don't share runtime
code by design (only `packages/contract`'s types are shared, per `CLAUDE.md`'s boundary
rule).

## `catalog.ts` and `graph-ops.ts` — hardcoded catalog, shared graph helpers

`catalog.ts` (108 lines) is the same 5-node catalog as `apps/backend/prisma/seed.ts`
(`04-data-model.md`) — `stripe.payment_received`, `slack.send_message`,
`teams.send_message`, `filter.condition`, `schedule.weekday_filter` — just as a hardcoded
TypeScript array instead of database rows, since the mock has no database to seed.
`graph-ops.ts` (63 lines) is nearly identical to `apps/backend/src/dto/diff.ts`
(`08-api-and-runs.md`) — in fact the real backend's `diffGraphs` was explicitly *ported
from* this file, specifically so both backends produce byte-identical diff shapes (see
`dto/diff.ts:1-4`'s comment). `makeNode` (`graph-ops.ts:14-19`) is worth noting: it sets
`position: { x: 0, y: 0 }` on every new node with a comment explaining why that's fine — the
frontend re-lays-out every graph with dagre on render (`10-frontend.md`) and never trusts a
server-supplied position.

## When to use which

- **Building/testing the real backend's behavior** (agent loop, validator, approval gate,
  workers, Redis) — always use `apps/backend`. The mock has none of this.
- **Iterating on frontend UI/UX** without wanting Postgres/Redis running, or demoing the
  chat UI standalone — the mock is faster to boot and requires zero infra.
- **If you change `packages/contract`** — both `apps/backend`'s routes *and* the mock's
  `server.ts`/DTO mappers need updating to stay in sync; they are not auto-generated from
  each other. This is the one place "keeping the mock around" has an ongoing cost, and it's
  a deliberate, accepted tradeoff (see `CLAUDE.md`'s build-phases note on this).

---
**Prev:** [`10-frontend.md`](./10-frontend.md) · **Next:**
[`12-end-to-end-trace.md`](./12-end-to-end-trace.md) · **Related:**
[`07-agent-and-providers.md`](./07-agent-and-providers.md),
[`08-api-and-runs.md`](./08-api-and-runs.md)
