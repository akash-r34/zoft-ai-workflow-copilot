# 12 — End-to-End Trace: One Message, Start to Finish

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

This is the payoff chapter. Every other chapter explained one layer in isolation; this one
follows a single user action — typing **"send a Slack message whenever Stripe receives a
payment"** and hitting Enter — through every hop across the whole stack, against the real
backend (`apps/backend`, not the mock — see `11-mock-backend.md` for how the mock's version
of this trace differs). Keep this open next to the source the first time you trace a bug —
it's the map for "where do I even start looking."

## The whole trip, as one diagram

```
Composer (keystroke)
  │
  ▼
useSendMessage.send()  ──POST /api/conversations/:id/runs──►  routes/conversations.ts
  │  (optimistic bubble,                                            │
  │   run-store not yet involved)                                   ▼
  │                                                          runs/run-service.ts: startRun()
  │                                                            ├─ ensureWorkflow()
  │                                                            ├─ maybeTitleConversation()
  │                                                            ├─ INSERT Run(status=pending)
  │                                                            ├─ INSERT Message(role=user)
  │                                                            └─ void runOrchestrator(...)  <- fire-and-forget
  │  {runId, messageId}                                               │
  ◄──────────────────────────────────────────────────────────────────┘
  │
  ▼
useRunStream (opens EventSource)  ──GET /api/runs/:runId/stream──►  runs/sse.ts: streamRun()
  │                                                          (subscribes to Redis, replays Postgres)
  │
  │                          ...meanwhile, in the fire-and-forget orchestrator...
  │
  │                          agent/orchestrator.ts: runOrchestrator() -> mainLoop()
  │                            ├─ appendEvent(run.started)
  │                            ├─ provider.run(ctx)  [ProviderRouter -> MockProvider]
  │                            │    yields: tool_use(search_nodes) -> tool_use(get_node_schema)
  │                            │            -> tool_use(propose_operations) -> finish
  │                            ├─ executeTool() for each tool_use delta
  │                            │    propose_operations -> applyOperations + validateGraph (valid!)
  │                            └─ handleProposal(): stash Run.proposedOps/proposedGraph,
  │                                appendEvent(workflow.proposed), RETURN (run stays "running")
  │
  │  every appendEvent() call -> nextSeq() -> INSERT run_event -> PUBLISH to Redis
  ◄══════════════════════════════════════════════════════════════════ (SSE frames arrive)
  │
  ▼
run-store.addEvent() for each frame  ──►  buildTimeline() renders ActivityTimeline
                                          selectPendingProposal() becomes truthy
  │
  ▼
ApprovalPanel renders, user clicks "Approve"
  │
  ▼
useApproveRun.mutate(runId)  ──POST /api/runs/:runId/approve──►  routes/runs.ts: approve handler
                                                                    │
                                                                    ▼
                                                          tools/commit.ts: commitProposal()
                                                                    │
                                                                    ▼
                                                    core/version-applier.ts: applyVersion()
                                                      ├─ re-run applyOperations + validateGraph
                                                      ├─ INSERT WorkflowVersion (in a transaction)
                                                      └─ UPDATE Workflow.currentVersionId
                                                                    │
                                              appendEvent(workflow.updated), appendEvent(run.completed)
  ◄══════════════════════════════════════════════════════════════════ (final SSE frames arrive)
  │
  ▼
useRunStream's onEvent: invalidateQueries(["workflow", ...], ["versions", ...], ["messages", ...])
  │
  ▼
WorkflowGraphView re-renders with the new graph + a brief added/changed highlight
```

## Hop by hop, with the exact file and line for each

### 1 — The user types and presses Enter

`Composer.tsx`'s `submit()` (`Composer.tsx:22-27`) trims the textarea value and calls the
`onSend` prop, which `ChatPane.tsx` wires to `useSendMessage(conversationId).send`
(`ChatPane.tsx:23,73-81`).

### 2 — The optimistic bubble, and the REST call

```ts
// apps/frontend/src/hooks/useSendMessage.ts:19-39 (abridged)
const mutation = useMutation({
  mutationFn: async (content) => api.createRun(conversationId, content),
  onMutate: (content) => setPending({ content, status: "pending" }),
  onSuccess: (data) => {
    setPending(null);
    if (conversationId) startRun(data.runId, conversationId);
    void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  },
  onError: () => setPending((prev) => (prev ? { ...prev, status: "error" } : prev)),
});
```

`onMutate` shows the user's bubble immediately from local component state
(`PendingMessage`, `useSendMessage.ts:9-12`) — not the TanStack Query cache, since it isn't
a real `MessageDto` yet. `api.createRun` (`lib/api.ts:72-76`) does
`POST /api/conversations/:id/runs`.

### 3 — The backend creates rows and launches the orchestrator, without waiting

```ts
// apps/backend/src/routes/conversations.ts:39-47
app.post("/api/conversations/:id/runs", async (request): Promise<CreateRunResponseDto> => {
  // ... conversation lookup, body parse ...
  return startRun(prisma, id, body.content);
});
```

```ts
// apps/backend/src/runs/run-service.ts:75-94 (abridged — see 08-api-and-runs.md for full detail)
export async function startRun(prisma, conversationId, content) {
  const workflow = await ensureWorkflow(prisma, conversationId);       // creates Workflow row if needed
  await maybeTitleConversation(prisma, conversationId, content);       // auto-titles from this message
  const run = await prisma.run.create({ data: { conversationId, status: "pending" } });
  const message = await prisma.message.create({ data: { conversationId, role: "user", content, runId: run.id } });

  const provider = getProvider();                                     // providers/factory.ts
  void runOrchestrator(provider, run.id, conversationId, workflow.id, content).catch(...);

  return { runId: run.id, messageId: message.id };
}
```

Notice `void runOrchestrator(...)` — the HTTP response (`{ runId, messageId }`) returns
**immediately**, before the agent has done anything. This is why step 4 has to happen next.

### 4 — The frontend opens the SSE stream for this run

```ts
// apps/frontend/src/hooks/useSendMessage.ts:29 -> startRun(data.runId, conversationId)
// apps/frontend/src/stores/run-store.ts:51-59 -> sets runId, resets events, outcome: "running"
// apps/frontend/src/hooks/useRunStream.ts:18-19 -> effect fires because runId changed
const close = openRunStream(runId, { onEvent: ..., onStatusChange: ... });  // lib/sse.ts:29
```

`openRunStream` opens a native `EventSource` against `GET /api/runs/:runId/stream`
(`lib/api.ts:109-111`'s `runStreamUrl`). On the backend, `routes/runs.ts:23-31` looks up the
run and calls `streamRun` (`runs/sse.ts:34`), which — per `08-api-and-runs.md` — subscribes
to this run's Redis channel *before* replaying anything from Postgres, so no event can be
lost in the gap between "the client connected" and "the orchestrator's next event."

### 5 — The orchestrator runs, calling tools, hitting no problems

```ts
// apps/backend/src/agent/orchestrator.ts:95-102 (mainLoop, start)
await appendEvent(runId, { event: "run.started", data: { runId } });
// ... loads catalog, current graph ...
await appendEvent(runId, { event: "agent.step", data: { kind: "planning", label: "Planning workflow..." } });
```

`pickScenario` (`mock-provider.ts:164-172`, `07-agent-and-providers.md`) sees no special
keyword ("timeout", "fail", "provider", "tool", "bad/broken", "why/explain") in our message
— it's the `"build"` scenario. `MockProvider.runBuild` (`mock-provider.ts:212-243`) yields,
in order: a `search_nodes` tool call, then (since `computeMutationOps` recognizes "stripe"
+ "slack" with no existing trigger, `mock-provider.ts:96-113`) a `get_node_schema` call, then
a `propose_operations` call with the ops to create a Stripe trigger + a Slack action node
connected by an edge, then `finish`.

Each delta flows through `handleDelta` (`orchestrator.ts:235-299`), which:
- For each `tool_use`, emits `agent.step` → `tool.call` → executes via `executeTool`
  (`tools/registry.ts:20`, `07-agent-and-providers.md`) → emits `tool.result`.
- For the `propose_operations` call specifically, `tools/propose-operations.ts:17-21` runs
  `applyOperations` (`core/applier.ts:26`) + `validateGraph` (`core/validator.ts:38`,
  `06-deterministic-core.md`) — this graph is well-formed (one trigger, everything
  reachable, config schemas satisfied), so it comes back `{ valid: true, graph }`.

### 6 — The orchestrator pauses at the proposal — no write yet

```ts
// apps/backend/src/agent/orchestrator.ts:342-356 (handleProposal, the APPROVAL_REQUIRED=true path)
await prisma.run.update({
  where: { id: runId },
  data: { proposedOps, proposedGraph, proposalSummary, proposalStatus: "pending" },
});
await appendEvent(runId, { event: "workflow.proposed", data: { workflowId, version: previewVersion, graph, diff, summary } });
// function returns here — run.status stays "running"
```

This is the exact moment covered in depth by `03-the-core-invariant.md` — the candidate
graph exists only as a stashed value on the `Run` row and in the SSE payload the frontend
just received. Nothing has been written to `workflow_version` yet.

### 7 — Every event along the way reaches the browser via Redis + Postgres

Each `appendEvent` call above (`runs/event-bus.ts:24-41`) does three things in order:
`nextSeq(runId)` (Redis-atomic, `redis/seq.ts:35`) assigns the next `seq`; the event is
inserted into `run_event` (Postgres — the sole replay source); the event is `PUBLISH`ed to
`run:{runId}` (`run-channel.ts:13-15`). The SSE handler holding this client's connection
(`runs/sse.ts`, opened in step 4) is subscribed to that channel and writes each one straight
through as an `id: {seq}\ndata: {...}\n\n` frame (`sse.ts:51-54`). See
`08-api-and-runs.md`'s "Real-time delivery" section for the full mechanics, including why
subscribe-before-replay matters.

### 8 — The frontend renders the stream as it arrives

```ts
// apps/frontend/src/stores/run-store.ts:61-70 (addEvent, called once per SSE frame)
addEvent: (evt) => {
  if (events.some((e) => e.seq === evt.seq)) return; // dedupe
  const next = [...events, evt].sort((a, b) => a.seq - b.seq);
  set({ events: next, receivedAt: {...}, outcome: outcomeFor(evt, get().outcome) });
},
```

Every frame appended here triggers a re-render of whatever's subscribed to the store.
`RunTurn.tsx:33-38` calls `buildTimeline(events, ...)` (`lib/step-map.ts:31`,
`10-frontend.md`) to turn the raw event list into the rows `ActivityTimeline` renders — so
by the time `workflow.proposed` arrives, the user has already watched "Planning workflow…",
"Searching available nodes…", "Reading node schema…", "Calling validator…" stream past in
real time.

### 9 — `workflow.proposed` arrives — the approval panel appears

```ts
// apps/frontend/src/stores/run-store.ts:117-132 (selectPendingProposal, re-evaluated on every render)
// returns the workflow.proposed payload, since no workflow.updated has arrived yet
```

`RunTurn.tsx:44,60-67` renders `<ApprovalPanel proposal={pendingProposal} ... />`
(`10-frontend.md`) showing the change summary and a `DiffView` of what would change. The run
stays open — the SSE connection is still live (heartbeats keep it alive,
`runs/sse.ts:89-91`) — waiting for a human decision.

### 10 — The user clicks Approve

```tsx
// apps/frontend/src/components/chat/RunTurn.tsx:60-66
<ApprovalPanel proposal={pendingProposal} isResolving={...} onApprove={() => approveRun.mutate(runId)} onReject={...} />
```

`useApproveRun` (`hooks/useApproveRun.ts:8-10`) is a bare `useMutation` calling
`api.approveRun(runId)` — `POST /api/runs/:runId/approve`.

### 11 — The approve route re-validates and commits — the only write in this whole trace

```ts
// apps/backend/src/routes/runs.ts:41-105 (abridged — full detail in 03-the-core-invariant.md)
app.post("/api/runs/:runId/approve", async (request) => {
  // ... look up run, confirm proposalStatus === "pending" ...
  const ops = run.proposedOps as unknown as Operation[];
  const result = await commitProposal(prisma, workflowId, ops, catalog, summary);  // tools/commit.ts:12
  // result.version/.graph -> success path below
  await prisma.run.update({ where: { id: runId }, data: { proposalStatus: "approved", status: "succeeded" } });
  await appendEvent(runId, { event: "workflow.updated", data: { workflowId, version: result.version, graph: result.graph, diff } });
  await appendEvent(runId, { event: "run.completed", data: { runId } });
  return { status: "approved", version: result.version };
});
```

`commitProposal` (`tools/commit.ts:12-20`) calls `applyVersion`
(`core/version-applier.ts:67`, `06-deterministic-core.md`), which — inside one Postgres
transaction — **re-runs** `applyOperations` + `validateGraph` against whatever the
workflow's current graph is right now (still `EMPTY_GRAPH`, since this is the very first
change), confirms it's still valid, inserts one new `WorkflowVersion` row (`version: 1`,
`createdBy: "ai"`, `parentVersionId: null`), and updates `Workflow.currentVersionId` to
point at it. This is the **only** database write in the entire trace that touches workflow
content.

### 12 — The final events land, and the UI settles

`workflow.updated` and `run.completed` arrive over the still-open SSE connection.
`useRunStream.ts:25-33`'s `onEvent` handler sees `workflow.updated` and invalidates the
`["workflow", workflowId]` and `["versions", workflowId]` TanStack Query caches; seeing a
terminal event (`run.completed`), it also invalidates `["messages", conversationId]` and
calls `close()` to end the `EventSource` connection (`useRunStream.ts:30-33`).
`selectLatestWorkflowUpdate(events)` (`run-store.ts:93`) now returns this payload, so
`WorkflowGraphView` (`10-frontend.md`) briefly ghost-renders the diff and settles on the new
graph — one Stripe trigger connected to one Slack action, exactly as described.

## What to hold onto from this trace

- **Two REST round-trips, one long-lived SSE connection, one database write.** The initial
  `POST .../runs` and the later `POST .../approve` are the only two client-initiated writes;
  everything in between is push-only over SSE.
- **The pause in step 6 is not a UI illusion — it's a real gap with nothing written.** If the
  browser tab were closed right after `workflow.proposed` and never reopened, the workflow
  would simply never change. Nothing times out into an automatic commit (`APPROVAL_REQUIRED`
  defaults `true`, `08-api-and-runs.md`'s env reference).
- **Every intermediate step is independently re-derivable from `events`.** If you reload the
  page mid-run, `useRunStream` reopens the connection with `Last-Event-ID` set to whatever
  `seq` was last seen, and the backend replays from Postgres — the timeline, the streamed
  text, and the pending-proposal state all reconstruct identically from the replayed events
  (`08-api-and-runs.md`, `10-frontend.md`).

---
**Prev:** [`11-mock-backend.md`](./11-mock-backend.md) · **Next:**
[`13-testing.md`](./13-testing.md) · **Related:**
[`03-the-core-invariant.md`](./03-the-core-invariant.md),
[`07-agent-and-providers.md`](./07-agent-and-providers.md),
[`08-api-and-runs.md`](./08-api-and-runs.md), [`10-frontend.md`](./10-frontend.md)
