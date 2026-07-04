# 13 — Testing

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

Tests live next to the code they cover, in a `__tests__/` directory beside the source file
— e.g. `apps/backend/src/core/applier.ts` is covered by
`apps/backend/src/core/__tests__/applier.test.ts` and
`applier.property.test.ts`. Both `apps/backend` and `apps/frontend` run tests with
[Vitest](https://vitest.dev) (`"test": "vitest run"` in both `package.json`s); the root
`pnpm test` runs `turbo run test`, which runs both packages' `test` script (and
`@zoft/contract`'s, if it has one) — see `turbo.json:18-21`.

## The four tiers

| Tier | Runs by default? | Gate | Example |
|---|---|---|---|
| **Pure unit** | Yes — always | none | `core/__tests__/applier.test.ts`, `providers/__tests__/circuit-breaker.test.ts` |
| **Property-based** | Yes — always | none | `core/__tests__/applier.property.test.ts` (uses `fast-check`) |
| **DB-gated integration** | No — skipped | `RUN_DB_INTEGRATION_TESTS=1` | `core/__tests__/version-applier.integration.test.ts` |
| **DB+Redis-gated integration** | No — skipped | `RUN_DB_INTEGRATION_TESTS=1 RUN_REDIS_INTEGRATION_TESTS=1` | `runs/__tests__/event-bus.integration.test.ts` |

Plain `pnpm test` (or `pnpm --filter @zoft/backend test`) runs only the first two tiers —
fast, hermetic, no Docker required. The gated tiers need real Postgres (+ Redis for the
second) running, and are opt-in on purpose.

## Why gated on a dedicated flag, not just `DATABASE_URL` presence

```ts
// apps/backend/src/core/__tests__/version-applier.integration.test.ts:6-22 (the file's own doc comment)
// Gated on a dedicated opt-in flag (RUN_DB_INTEGRATION_TESTS), NOT merely on
// DATABASE_URL being set: importing "@prisma/client" auto-loads
// apps/backend/.env as a side effect, so DATABASE_URL is already populated
// for any developer who has followed the normal onboarding step of copying
// .env.example to .env — whether or not Postgres is actually running. Gating
// on that alone would make `pnpm test` silently attempt a live DB connection
// (and fail/hang) for anyone with a plain .env and no Docker running.
```

This is a real gotcha worth internalizing (also called out in `CLAUDE.md`): any test file
that imports `@prisma/client` transitively loads `.env`, so `DATABASE_URL` will *look* set
even when nothing is listening on it. Every DB-touching integration test in this repo reads
its own dedicated env flag instead (`RUN_DB_INTEGRATION_TESTS`, and for anything touching
the Redis-backed SSE pipeline, additionally `RUN_REDIS_INTEGRATION_TESTS`) via
`describe.skipIf(!RUN_DB_INTEGRATION_TESTS)(...)` — see
`version-applier.integration.test.ts:24` and `event-bus.integration.test.ts:31`. If you add
a new integration test that touches Postgres or Redis, follow this exact pattern rather than
checking `DATABASE_URL`/`REDIS_URL` directly.

To actually run the gated tiers locally:

```bash
docker compose -f infra/docker-compose.yml up -d       # Postgres + Redis only
RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @zoft/backend test -- version-applier.integration
RUN_DB_INTEGRATION_TESTS=1 RUN_REDIS_INTEGRATION_TESTS=1 pnpm --filter @zoft/backend test -- event-bus
# or, to run every gated + ungated test in one pass:
RUN_DB_INTEGRATION_TESTS=1 RUN_REDIS_INTEGRATION_TESTS=1 pnpm --filter @zoft/backend test
```

## Pattern 1 — pure unit tests with an in-memory fake

`core/__tests__/version-applier.test.ts` tests `applyVersion`/`restoreVersion`
(`06-deterministic-core.md`) **without a real database at all** — it passes an in-memory
object structurally compatible with the subset of `PrismaClient` those functions actually
call (see `version-applier.ts:55-57`'s doc comment, which explicitly calls this fake out as
the reason the function's `prisma` parameter type is written the way it is). The DB-gated
integration test (above) exists specifically to check that fake stays faithful to the real
client's behavior — read both files side by side if you're ever unsure whether the fake is
missing something.

## Pattern 2 — property-based testing for the applier

`core/__tests__/applier.property.test.ts` uses `fast-check` to generate large numbers of
random `Operation[]` sequences and assert general properties hold (e.g. that a
`remove_node` immediately following the matching `add_node` returns to the original graph)
— rather than hand-writing one test per hand-picked case. This only works because
`applyOperations` is pure (`06-deterministic-core.md`'s "why pure is worth defending"
section) — no I/O, no hidden state, so the same random input always produces the same
checkable output.

## Pattern 3 — an injected clock for time-dependent logic

```ts
// apps/backend/src/providers/__tests__/circuit-breaker.test.ts:31-44
it("transitions from open to half-open once the cooldown elapses (injected clock)", () => {
  let now = 0;
  const breaker = new CircuitBreaker(1, 1000, () => now);
  breaker.onFailure();
  expect(breaker.getState()).toBe("open");

  now += 999;
  expect(breaker.canAttempt()).toBe(false); // cooldown not yet elapsed
  now += 1;
  expect(breaker.canAttempt()).toBe(true);
  expect(breaker.getState()).toBe("half_open");
});
```

`CircuitBreaker`'s constructor takes an optional `now: () => number` parameter
(`circuit-breaker.ts:20`, defaulting to `Date.now`) purely so tests can drive state
transitions deterministically without `vi.useFakeTimers()` or real `setTimeout` delays. If
you ever write a new piece of logic that depends on wall-clock time, prefer this pattern —
an injected clock function — over reaching for a timer-mocking library first.

## Pattern 4 — a test-only fake implementing a real interface

`providers/__tests__/router.test.ts` tests `ProviderRouter`
(`07-agent-and-providers.md`) against a `FailingProvider` fake that always throws
`ProviderError` and a `WorkingProvider` fake that yields a fixed sequence of deltas — both
are just `LlmProvider` implementations, the same interface `MockProvider` implements. This
is the general pattern for testing anything built around an interface in this codebase:
write a minimal fake that implements the interface with exactly the behavior the test needs
(always fail, always succeed, fail then succeed), rather than mocking internals.

## Pattern 5 — polling for asynchronous, cross-process side effects

```ts
// apps/backend/src/runs/__tests__/event-bus.integration.test.ts:21-29
/** Polls until `check()` is true or the timeout elapses — Redis pub/sub delivery is async, unlike the old in-process direct callback it replaced. */
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!check()) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}
```

Once real-time delivery moved to Redis pub/sub (`08-api-and-runs.md`), a test that publishes
an event and immediately asserts a subscriber received it is inherently racy — delivery is
asynchronous over a real network round trip, even to `localhost`. `waitUntil` is the
house pattern for this: poll a condition on an interval until it's true or a timeout is hit,
rather than asserting immediately or adding an arbitrary fixed `sleep`.

## Frontend tests — pure functions, no rendering library

`apps/frontend/src/__tests__/{dagre-layout,run-store,step-map}.test.ts` all test **pure
functions** — `layoutGraph` (`lib/dagre-layout.ts`), the `run-store.ts` selectors
(`selectPendingProposal`, etc.), and `buildTimeline` (`lib/step-map.ts`) — directly, with
plain data in and assertions on the returned value out. None of them render a component or
need a DOM/testing-library setup, which is exactly the payoff of keeping rendering "a pure
function of the ordered event list" (`10-frontend.md`): the logic worth unit-testing is
separable from React entirely.

## The manual, non-automated check: cross-process SSE fan-out

One guarantee in this codebase has no automated test, by nature of what it's proving: that
two separate backend **processes** correctly share a run's live event stream via Redis
pub/sub (`08-api-and-runs.md`). This was verified manually — boot two backend instances on
different ports against the same Postgres + Redis, start a run against instance A, open an
SSE connection to instance B for that run's id, and confirm every event arrives with `seq`
strictly monotonic. If you ever touch `redis/seq.ts`, `runs/run-channel.ts`, or
`runs/sse.ts`, re-run this manual check — the gated integration tests cover the atomic-seq
math and the pub/sub round trip in isolation, but not this specific "two full backend
processes, same run" scenario end-to-end.

## `test-evidence/` — captured proof, not a test suite

`test-evidence/logs/` (typecheck/lint/build/unit-test/DB-integration-test output) and
`test-evidence/screenshots/` (a 22-step Playwright walkthrough covering every scenario, the
approval gate, diff highlighting, version history, and all five failure states) are
committed, point-in-time **captured evidence** that the full stack works end to end — not
something `pnpm test` regenerates. If you make a change that should visibly affect the UI or
the verification output, consider whether these are worth refreshing (see the git history for
the exact commands used to regenerate them), but they are documentation artifacts, not part
of the automated test run.

## CI (`.github/workflows/ci.yml`)

```yaml
# .github/workflows/ci.yml:26-39
- name: Install dependencies
  run: pnpm install --frozen-lockfile
- name: Build contract package
  run: pnpm --filter @zoft/contract build
- name: Typecheck all packages
  run: pnpm -r typecheck
- name: Lint all packages
  run: pnpm -r lint
- name: Run tests
  run: pnpm test
```

Five steps, in order, on every push to `main`/`develop` and every PR into `main`
(`ci.yml:3-7`): frozen-lockfile install, build the contract package first (both apps depend
on its compiled output), typecheck everything, lint everything, then `pnpm test`. Note CI
has **no** `DATABASE_URL`/`REDIS_URL`/`RUN_*_INTEGRATION_TESTS` set at all, so the gated
tiers always skip there — CI only ever proves the pure-unit + property-based tiers, by
design. All five steps must be green before merging (`CLAUDE.md`).

---
**Prev:** [`12-end-to-end-trace.md`](./12-end-to-end-trace.md) · **Next:**
[`14-ops-and-docker.md`](./14-ops-and-docker.md) · **Related:**
[`06-deterministic-core.md`](./06-deterministic-core.md),
[`07-agent-and-providers.md`](./07-agent-and-providers.md)
