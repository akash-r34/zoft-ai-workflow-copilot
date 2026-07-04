# Phases 4–5 — Done

The frontend (`Plans/03-frontend.md`, both build phases) is implemented and
verified: three-region layout, SSE-driven streaming chat with a live agent
activity timeline, React Flow + dagre workflow visualisation with diff
highlighting, version history with restore, all seven failure states from
section 8, Stop/Escape cancellation, reconnect-with-replay, dark mode, and a
multi-session conversation sidebar. All acceptance criteria for both phases
pass. Started from commit `b36391a`.

## Ordering deviation: built ahead of Phase 2–3

The backend's AI orchestration and runtime phases (`Plans/02-backend.md`
Phase 2–3) don't exist yet — no HTTP routes, no SSE emission, no agent loop.
Rather than block the frontend on that, it was built against a **self-contained
mock backend** (`apps/frontend/mock/`) that implements the real
`packages/contract` REST + SSE surface verbatim against an in-memory store.
This is the brief's "two separate teams talking only through the contract"
made concrete: nothing in `apps/frontend/src` imports from `mock/`, and
pointing `NEXT_PUBLIC_API_URL` at a real backend later is a one-line change.
Phase 2 (backend AI orchestration) is still the next **backend** milestone —
this doesn't change the plan's phase order for that side.

## What was built

- **`apps/frontend/mock/server.ts`** — Fastify server, every route from
  `Plans/04-api-contract.md`, mapping the mock's private storage rows
  (`mock/types.ts`) to real `@zoft/contract` DTOs at the route boundary.
- **`apps/frontend/mock/scenarios.ts`** — the deterministic "AI": keyword-matches
  the user's message to one of the six brief scenarios (create, swap provider,
  threshold filter, weekday filter, explain, why) or five failure injections
  (timeout, final validation failure, self-correcting retry, provider
  failover, recoverable tool failure), then emits a scripted, paced SSE event
  sequence through the same `appendEvent`/`subscribe` path a real run would
  use — persisted for replay, pushed live to any subscriber.
- **`src/lib/api.ts`, `src/lib/sse.ts`** — typed REST client and an
  `EventSource` wrapper with a heartbeat watchdog (flips to `"reconnecting"`
  after 20s of silence).
- **`src/stores/run-store.ts`** (Zustand) — the live run: ordered `SseEvent[]`
  reduced and deduped by `seq`, scoped to the `conversationId` that started it
  so a run never leaks into a different conversation the user has switched to.
- **`src/lib/step-map.ts`** — pure `SseEvent[] → timeline rows` reducer
  (agent.step rows absorb their tool.call/tool.result pair; validation.error,
  retry, and provider.switched get their own rows; approximate per-row timing
  from client receive timestamps, since the contract carries no server
  timestamp).
- **`src/lib/dagre-layout.ts`** — pure `WorkflowGraph → positioned React Flow
  nodes/edges`, left-to-right, server-supplied `position` ignored.
- **`src/components/`** — `Workspace` (three-region layout, sidebar,
  keyboard shortcuts), `chat/` (message list, composer, activity timeline,
  failure banners), `workflow/` (React Flow graph view with diff-highlight
  animation, version history, diff view), `ui/` (connection badge, theme
  toggle).
- **29 Vitest unit tests** for the three pure-logic modules above
  (`run-store`, `dagre-layout`, `step-map`) — no DOM, no network.
- **`apps/frontend/README.md`** — the major UI decisions and why.

## Decisions made that weren't fully prescribed by the plan

**The mock is a full peer implementation of the contract, not a stub.** It has
its own durable per-run SSE event log, `Last-Event-ID` replay, cancellation,
version history, and diff computation — everything the frontend needs to
exercise every acceptance criterion for real, including the reconnect and
Stop tests. It was deliberately built to the same rigor as a real backend
would be for this surface, not hand-waved.

**Failure scenarios are keyword-triggered from the chat input** (`timeout`,
`fail`, `bad`/`broken`, `provider`, `tool` in the message text), rather than
requiring a hidden dev panel. Typing "this will timeout on purpose" is the
whole affordance — this doubles as the reviewer/demo path for section 8's
failure states without adding UI surface the real backend wouldn't have.

**Resume from draft and Retry are currently the same action.** The mock (like
the real backend would) never writes a version until validation passes, so
there's no actual uncommitted "draft" graph to resume from — both buttons
resend the original request. This is called out explicitly in the failure
banner's code comment and the README, not silently glossed over; a real
backend that preserved partial agent state could make Resume skip the
earlier steps.

**A run is scoped to the conversation that started it** (`run-store`'s
`conversationId` field). Multi-session switching mid-run was not in the
original plan's explicit scope, but building the sidebar surfaced a real bug
(a run's live timeline leaking into a different conversation) that needed a
first-class fix rather than a workaround — see verification below.

**Cache-write-not-invalidate for conversation creation.** Creating a
conversation and immediately selecting it raced against
`invalidateQueries`'s async refetch: the newly-selected id briefly didn't
exist in the (stale) cached list, and an effect meant to correct a *stale*
selection instead reverted a *valid new* one back to the old conversation.
Fixed by writing the created conversation straight into the TanStack Query
cache (`setQueryData`) instead of just invalidating — see Query Client
gotchas below.

**The viewport re-fits imperatively on node-set change, not via React Flow's
`fitView` prop.** That prop only fits once, on mount; a graph that grows
upstream of the trigger (inserting a filter between the trigger and
everything else) silently scrolled newly-shifted nodes off-screen. Fixed with
an inner `<ReactFlowProvider>` + `useReactFlow().fitView()` effect keyed on
the sorted node-id set.

**Dark mode boots from an inline pre-hydration script**, not a client
`useEffect`, to avoid a light-flash-then-dark flicker on load — the
localStorage read and class application happen before first paint.

## TanStack Query gotchas worth remembering

Two real bugs traced back to the same class of mistake — treating
`useMutation`'s per-call `mutate(vars, { onSuccess })` as equivalent to
awaiting the result:

1. Per-call `onSuccess` is gated by `hasListeners()` internally — against a
   request this fast (a local mock), the callback can silently not fire.
   Fixed with `mutateAsync().then(...)`, a plain promise unaffected by that
   guard.
2. Even with the callback firing, selecting a just-created entity immediately
   raced the invalidate-triggered refetch (see above) — fixed by writing the
   cache directly in `onSuccess` rather than invalidating.

Both were only caught by actually driving the app (Playwright + a
`data-*` debug attribute to inspect real component state), not by
typecheck/lint/unit tests — none of those would have failed.

## Verification performed

- `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` (root, all four workspace
  packages) all exit 0.
- `pnpm --filter @zoft/frontend build` (production Next.js build) succeeds.
- Mock backend exercised directly via `curl`: all six brief scenarios, all
  five failure injections, cancellation, and `Last-Event-ID` replay after a
  cancelled run — all correct, no gaps or duplicate `seq` values.
- Full app driven with Playwright (Chromium) against both the dev server and
  the production build: create → swap provider → add threshold → add weekday
  filter → explain → why, each showing streamed steps, streamed prose, and
  the correct graph/diff; all five failure banners with working next
  actions; Stop mid-run; a real network-drop-and-restore reconnect showing
  no gaps or duplicate steps; dark mode; multi-session isolation (a run
  started in one conversation does not appear in another); and a full page
  reload restoring messages, workflow, and version history from the mock.
- Five real bugs were found and fixed via this Playwright-driven testing (not
  by typecheck/lint, which stayed green throughout): the `Content-Type`/empty-body
  500, the StrictMode double-create race, the two TanStack Query races above,
  and the `fitView` staleness — see decisions above.

## `pnpm --filter @zoft/frontend exec vitest run --reporter=verbose` output

```
 RUN  v1.6.1 /Users/akashr/Zoft AI - Assignment/apps/frontend

 ✓ src/__tests__/step-map.test.ts > buildTimeline > creates one row per agent.step, marking every row but the last as done
 ✓ src/__tests__/step-map.test.ts > buildTimeline > attaches a tool.call/tool.result pair to the preceding agent.step row rather than adding new rows
 ✓ src/__tests__/step-map.test.ts > buildTimeline > marks a row as error when its tool.result is not ok, and carries the error text
 ✓ src/__tests__/step-map.test.ts > buildTimeline > gives validation.error its own row carrying the structured errors, not attached to a step
 ✓ src/__tests__/step-map.test.ts > buildTimeline > renders retry and provider.switched as their own rows
 ✓ src/__tests__/step-map.test.ts > buildTimeline > settles the last row to done once the run finishes successfully
 ✓ src/__tests__/step-map.test.ts > buildTimeline > settles the last row to error when the run ultimately fails
 ✓ src/__tests__/step-map.test.ts > buildTimeline > leaves the last row running while the run is still in flight
 ✓ src/__tests__/step-map.test.ts > buildTimeline > approximates per-row timing from client receive timestamps between consecutive rows
 ✓ src/__tests__/step-map.test.ts > buildTimeline > ignores token and workflow.updated events entirely (they don't drive the timeline)
 ✓ src/__tests__/run-store.test.ts > run-store > starts a run scoped to a conversation, with a clean event log
 ✓ src/__tests__/run-store.test.ts > run-store > orders events by seq regardless of arrival order
 ✓ src/__tests__/run-store.test.ts > run-store > dedupes an event replayed at the same seq (reconnect replay)
 ✓ src/__tests__/run-store.test.ts > run-store > accumulates streamed token text in seq order
 ✓ src/__tests__/run-store.test.ts > run-store > transitions outcome to completed on run.completed
 ✓ src/__tests__/run-store.test.ts > run-store > transitions outcome to failed on run.failed
 ✓ src/__tests__/run-store.test.ts > run-store > transitions outcome to cancelled on run.cancelled
 ✓ src/__tests__/run-store.test.ts > run-store > transitions outcome to timed_out on run.timeout
 ✓ src/__tests__/run-store.test.ts > run-store > a heartbeat (or any other in-flight event) leaves outcome unchanged
 ✓ src/__tests__/run-store.test.ts > run-store > selectTerminalFailureEvent returns the most recent failure-shaped terminal event
 ✓ src/__tests__/run-store.test.ts > run-store > selectTerminalFailureEvent returns undefined for a successful run
 ✓ src/__tests__/run-store.test.ts > run-store > reset clears the run back to its initial, unscoped state
 ✓ src/__tests__/dagre-layout.test.ts > layoutGraph > produces exactly one positioned React Flow node per graph node
 ✓ src/__tests__/dagre-layout.test.ts > layoutGraph > lays out left to right: a source node sits left of its target
 ✓ src/__tests__/dagre-layout.test.ts > layoutGraph > is deterministic for the same input graph
 ✓ src/__tests__/dagre-layout.test.ts > layoutGraph > ignores the server-supplied position entirely
 ✓ src/__tests__/dagre-layout.test.ts > layoutGraph > marks a node's diffState only when it appears in the corresponding highlight set
 ✓ src/__tests__/dagre-layout.test.ts > layoutGraph > labels a conditional edge sourced from a filter.condition node
 ✓ src/__tests__/dagre-layout.test.ts > layoutGraph > leaves an edge unlabeled when its source isn't a conditional node

 Test Files  3 passed (3)
      Tests  29 passed (29)
```

## Open questions for Phase 2 (backend) and the eventual real-backend swap

1. **The mock's scenario logic will need a real counterpart, not a port.**
   `mock/scenarios.ts`'s keyword matching is a stand-in for the real agent
   loop (`search_nodes`, `get_node_schema`, `propose_operations`, `commit` —
   see `Plans/02-backend.md` §3). The SSE event *shapes* it emits are exactly
   the real contract, so the frontend needs no changes when Phase 2/3 land;
   only `NEXT_PUBLIC_API_URL` needs to point at the real backend.
2. **Timing shown in the activity timeline is approximate and client-side**
   (derived from receive timestamps, since `SseEvent` carries no server
   timestamp). If real per-step timing becomes a requirement, that's a
   contract change (`packages/contract/src/events.ts`), not a frontend one.
3. **No pagination.** The mock's list endpoints (`conversations`,
   `node-definitions`, `versions`) ignore the `cursor` param `04-api-contract.md`
   documents. Fine at prototype scale; a real backend implementing real
   pagination will need corresponding `useInfiniteQuery` hooks on the frontend
   side, not just backend work.
4. **`apps/frontend/mock/` ships in the repo but is dev-only** — it's not
   part of the Phase 6 production Dockerfile/compose target. Worth an
   explicit note in that phase's docs so it isn't accidentally containerized
   alongside the real backend.
