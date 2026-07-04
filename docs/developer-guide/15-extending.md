# 15 — Extending the System: Recipes

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

Six common changes, each as an ordered list of exactly which files to touch, and which
invariant checks to keep in mind. Read `03-the-core-invariant.md` before any recipe that
touches how a workflow gets edited — every one below was designed against it.

## Recipe 1 — Add a new node type to the catalog

Adding a node type is meant to be a **data change**, not a code change — this is stated
directly in `prisma/schema.prisma`'s `NodeDefinition` doc comment (`04-data-model.md`).

1. Add an entry to `NODE_CATALOG` in `apps/backend/prisma/seed.ts:20-113` — pick a `type`
   string (e.g. `"github.issue_created"`), `category` (`"trigger"` or `"action"`),
   `configSchema` (a JSON Schema object — this is what `core/validator.ts`'s
   `checkConfigSchemas` compiles with `ajv`, `06-deterministic-core.md`), and `inputs`/
   `outputs` (used by `checkTypeCompatibility` — use `"any"` for a wildcard).
2. Run `pnpm --filter @zoft/backend db:seed` — the seed is an idempotent upsert
   (`seed.ts:116-122`), safe to re-run.
3. **Mirror the same entry in `apps/frontend/mock/catalog.ts`** if you want the mock
   (`11-mock-backend.md`) to know about it too — it's a hardcoded array there, not seeded,
   and the two are not kept in sync automatically.
4. That's it for the catalog itself. The embedding worker
   (`workers/embedding-worker.ts:68-74`, `09-workers.md`) will pick up the new row on its
   next boot-time scan for `embedding IS NULL` rows and embed it automatically — no extra
   step needed.
5. If you want `MockProvider` to actually propose workflows using the new type, extend
   `computeMutationOps` in `apps/backend/src/providers/mock-provider.ts:59-153`
   (`07-agent-and-providers.md`) with a new keyword-matched branch — and, if you want the
   mock backend's scenario engine to demo it too, the equivalent branch in
   `apps/frontend/mock/scenarios.ts`.

## Recipe 2 — Add a new agent tool

1. Add the implementation to `apps/backend/src/tools/read-tools.ts` (if it's read-only) or a
   new file next to it — follow the existing signature:
   `(ctx: ToolContext, input: SomeInput) => ToolResult | Promise<ToolResult>`
   (`tools/types.ts:10-18`).
2. Add its name to `KNOWN_TOOLS` and a `case` in `executeTool`'s switch,
   `apps/backend/src/tools/registry.ts:12-38` (`07-agent-and-providers.md`). This is the
   **only** dispatch point — a tool not registered here is unreachable no matter what a
   provider yields.
3. If `MockProvider` should be able to call it, add a `tool_use` delta yielding this tool's
   name in the relevant scenario method in `providers/mock-provider.ts`.
4. **If the tool can write anything**, stop and re-read `03-the-core-invariant.md` first —
   every existing tool except `propose_operations` is read-only, and even
   `propose_operations` never writes (`06-deterministic-core.md`). A new writing tool would
   need its own deliberate design against the invariant, not a quick addition.
5. Add a test in `apps/backend/src/tools/__tests__/registry.test.ts` (async, per the
   existing pattern — `executeTool` is `async`, `13-testing.md`).

## Recipe 3 — Add a new SSE event type

This one is **contract-first**, since `SseEvent` is a discriminated union both apps
consume:

1. Add the new variant to `SseEvent` in `packages/contract/src/events.ts:13-29`
   (`05-contract-package.md`) — follow the existing pattern:
   `(BaseEvent & { event: "your.event"; data: {...} })`.
2. Rebuild the contract package: `pnpm --filter @zoft/contract build`.
3. Backend: call `appendEvent(runId, { event: "your.event", data: {...} })`
   (`runs/event-bus.ts:24`, `08-api-and-runs.md`) from wherever the new event should fire.
   No other backend change is needed — `seq` assignment, persistence, and Redis publish are
   all handled generically by `appendEvent`.
4. Frontend: **the TypeScript compiler is your checklist here.** Any exhaustive `switch`
   over `evt.event` — `lib/step-map.ts`'s `buildTimeline` (`step-map.ts:41-108`,
   `10-frontend.md`) is the main one — will fail to compile until you add a `case` for the
   new event (or confirm the existing `default: break;` is really the right behavior for
   it). Decide deliberately whether this event should render a new timeline row, or is
   purely informational for another consumer (e.g. `run-store.ts`'s `outcomeFor`,
   `run-store.ts:28-41`, if it affects the run's terminal outcome).
5. Add the new variant to `docs/api.md`'s SSE reference table.

## Recipe 4 — Add a new REST route

1. Add the DTO/Zod-body-schema to `packages/contract/src/api.ts` if the route needs a typed
   response or a validated request body (`05-contract-package.md`).
2. Add the handler to an existing route module (`apps/backend/src/routes/*.ts`) if it
   belongs to an existing resource, or a new `routes/your-thing.ts` file exporting a
   `registerYourThingRoutes(app: FastifyInstance): void` function, following every existing
   module's pattern (`08-api-and-runs.md`).
3. Register it in `apps/backend/src/app.ts:26-32`'s `buildApp` — a route module that isn't
   called from here is simply never mounted.
4. Throw `ApiErrorException(code, message, status)` (`routes/errors.ts:8-16`) for any
   expected failure — never hand-roll a response shape; the shared error handler
   (`routes/errors.ts:18-38`) is the only place that formats the error envelope.
5. **If this route can write a workflow's graph**, it must go through
   `core/version-applier.ts`'s `applyVersion`/`restoreVersion` — no exceptions. Compare
   against `routes/runs.ts`'s approve handler (`03-the-core-invariant.md`) as the template
   for "validate, write once, emit the resulting SSE events."
6. Mirror the route in `apps/frontend/mock/server.ts` if the frontend should be able to
   exercise it against the mock too (`11-mock-backend.md`).
7. Add the endpoint to `docs/api.md`.

## Recipe 5 — Add a real `LlmProvider` (e.g. `AnthropicProvider`)

This is the one recipe with a concrete, pre-planned target — see `REMAINING.md` for the
full context on why it isn't built yet (needs a paid `ANTHROPIC_API_KEY` to ever verify).

1. Implement `LlmProvider` (`providers/types.ts:41-44`, `07-agent-and-providers.md`) in a
   new `apps/backend/src/providers/anthropic-provider.ts` — `run(ctx: TurnContext):
   AsyncIterable<ProviderDelta>`. Throw `ProviderError` (`providers/types.ts:47-55`)
   specifically for "this provider is unavailable" conditions (auth failure, rate limit,
   connection refused) — that's the one exception type `ProviderRouter`
   (`providers/router.ts`) knows to catch and fail over on.
2. Consult the `claude-api` skill for current model ids (default should be
   `claude-opus-4-8`), the exact tool-definition JSON shape, and streaming event names —
   `TurnContext`/`ProviderDelta` are modeled loosely on Anthropic's Messages API for exactly
   this reason (`providers/types.ts:1-7`'s comment).
3. Change exactly one line in `providers/factory.ts:27`:
   ```ts
   cached = new ProviderRouter([new AnthropicProvider(), new MockProvider()]);
   ```
   **No other code changes anywhere** — `agent/orchestrator.ts`'s call site, the circuit
   breaker, the SSE event mapping, all already work generically
   (`07-agent-and-providers.md`'s "Zero call-site impact" section).
4. Remove the `throw new Error(...)` guard for `LLM_PROVIDER === "anthropic"`
   (`providers/factory.ts:22-25`) once the above is wired up and tested.
5. Add `providers/__tests__/anthropic-provider.test.ts` — but note it will need either a
   real (paid, rate-limited) API call or a mocked HTTP layer; decide deliberately which,
   since this is the one place in the codebase where "hermetic unit test" and "faithful
   integration test" genuinely trade off against each other.
6. Note the known limitation this makes real rather than theoretical: mid-stream provider
   failover (`providers/router.ts:13-18`, `07-agent-and-providers.md`) — a network drop
   partway through a real streaming response is now a real failure mode to consider, not
   just a documented scope cut.

## Recipe 6 — Add a new background worker

1. Add the queue name + payload type to `apps/backend/src/queues/queue-names.ts:4-23`
   (`09-workers.md`).
2. Add an `enqueue*` helper to `apps/backend/src/queues/queues.ts`, following the existing
   pattern exactly: `upsertPending` a `Job` row, then `queue.add(name, payload, { jobId:
   idempotencyKey, ...DEFAULT_JOB_OPTS })` — use `-` in the `idempotencyKey`, never `:`
   (BullMQ rejects colons in a `jobId`, `queues.ts:6-8`'s comment).
3. Add `apps/backend/src/workers/your-worker.ts` — a `startYourWorker(): Worker<...>`
   function constructing a `new Worker(QUEUE.yourQueue, async (job) => {...}, {
   connection: getBullConnection(), concurrency: env.WORKER_CONCURRENCY })`, with a
   `worker.on("failed", ...)` handler calling `markFailed` (mirror any of the three existing
   workers, e.g. `archival-worker.ts:32-58`, for the exact shape).
4. Extract the worker's core logic as **pure, exported functions** wherever possible (see
   `validation-worker.ts`'s `collectFindings`/`summarize`, or `archival-worker.ts`'s
   `cutoffDate`/`isArchivable`) — this is what makes the worker unit-testable without a
   live queue or database (`13-testing.md`).
5. Wire it into `apps/backend/src/workers/main.ts:13-15` (and, if it needs a repeatable
   schedule, register it there too, following `registerArchivalRepeatable`'s pattern).
6. **Check it against the core invariant explicitly** (`03-the-core-invariant.md`): does
   this worker need to write to `Workflow`/`WorkflowVersion`? If yes, it must go through
   `core/version-applier.ts` like everything else — a worker is not a special exemption.
   If it's a lifecycle annotation (like `archivedAt`) or fully read-only (like the
   validation sweep), document that scoping explicitly in the worker's own file header
   comment, the way all three existing workers do.
7. Add a unit test under `workers/__tests__/your-worker.test.ts` for the pure logic; add it
   to `docs/architecture.md`'s worker list and `REMAINING.md` if it changes what's
   documented as built vs. deferred.

---
**Prev:** [`14-ops-and-docker.md`](./14-ops-and-docker.md) · **Related:**
[`03-the-core-invariant.md`](./03-the-core-invariant.md),
[`REMAINING.md`](../../REMAINING.md)

This is the last chapter — see [`INDEX.md`](./INDEX.md) to jump anywhere else.
