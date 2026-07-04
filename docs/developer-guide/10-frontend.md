# 10 — The Frontend

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

`apps/frontend` is a Next.js 14 App Router app. It talks to the real backend
(`08-api-and-runs.md`) over REST + SSE using the exact same `@zoft/contract` types
(`05-contract-package.md`) the backend does — there is no separate frontend-only type for
a `WorkflowGraph` or an `SseEvent`. (There is a second, independent mock backend the
frontend can also point at — see `11-mock-backend.md`, not covered here.)

## The one architectural decision that shapes everything else: two kinds of state

The frontend deliberately splits state into two systems that never overlap:

| | TanStack Query | Zustand (`stores/run-store.ts`) |
|---|---|---|
| What it holds | **Server state** — conversations, messages, workflow, versions, node catalog | **Live-run state** — the in-flight SSE event stream for whichever run is currently executing |
| Source | REST fetches, cached | SSE frames, appended in real time |
| Survives a refresh? | Yes (refetched) | **No** — resets to empty on reload |
| Example hook | `useConversations`, `useMessages`, `useWorkflow`, `useVersions`, `useNodeDefinitions` | `useRunStream` (bridges SSE into the store) |

The rule of thumb: if it's a REST resource that would still be true after a page refresh,
it's TanStack Query. If it's "what is this run doing *right now*," it's the run store. This
is why every hook in `apps/frontend/src/hooks/` (9 files) is a thin `useQuery`/`useMutation`
wrapper around one `api.ts` call (`hooks/useWorkflow.ts`, `useVersions.ts`,
`useConversations.ts`, `useMessages.ts`, `useNodeDefinitions.ts` are each under 30 lines) —
none of them hold their own state; TanStack Query does that for them.

## `stores/run-store.ts` — the live-run state machine

```ts
// apps/frontend/src/stores/run-store.ts:43-83 (the store itself, abridged)
export const useRunStore = create<RunState>((set, get) => ({
  runId: null, conversationId: null, events: [], receivedAt: {},
  connectionStatus: "connecting", outcome: null,

  startRun: (runId, conversationId) => set({ runId, conversationId, events: [], receivedAt: {}, connectionStatus: "connecting", outcome: "running" }),

  addEvent: (evt) => {
    const { events, receivedAt } = get();
    if (events.some((e) => e.seq === evt.seq)) return;  // dedupe replayed events on reconnect
    const next = [...events, evt].sort((a, b) => a.seq - b.seq);
    set({ events: next, receivedAt: { ...receivedAt, [evt.seq]: Date.now() }, outcome: outcomeFor(evt, get().outcome) });
  },
  // ...
}));
```

The file's own header comment (`run-store.ts:1-5`) states the design principle plainly:
"rendering (chat prose, timeline, workflow diff) is a pure function of `events`, reduced by
`seq`." `addEvent`'s dedup-by-`seq` check (`run-store.ts:63`) is the frontend-side backstop
mentioned in `08-api-and-runs.md` — even if the backend's replay/live reconciliation ever
double-delivered an event, this line would still make it a no-op here.

### Pure selectors — the reducer pattern applied to `SseEvent[]`

Below the store, `run-store.ts` exports several plain functions that take an `events` array
and derive something from it — deliberately kept free of the store's internals
(`run-store.ts:85`'s section comment) so they're independently unit-testable
(`13-testing.md`):

| Selector | Line | What it derives |
|---|---|---|
| `selectStreamedText` | `run-store.ts:86` | Concatenates every `token` event's text — the live streaming prose |
| `selectLatestWorkflowUpdate` | `run-store.ts:93` | The most recent `workflow.updated` payload (for the graph diff highlight) |
| `selectIsTerminal` | `run-store.ts:103` | Whether the run has reached any non-`"running"` outcome |
| `selectPendingProposal` | `run-store.ts:117` | The approval-gate payload — see below |
| `selectTerminalFailureEvent` | `run-store.ts:136` | The most recent failure-shaped terminal event, for `FailureBanner` |

### `selectPendingProposal` — how the frontend knows a proposal is awaiting a human

```ts
// apps/frontend/src/stores/run-store.ts:117-132
export function selectPendingProposal(events: SseEvent[]): ... | undefined {
  let proposed, proposedSeq = -1, updatedSeq = -1;
  for (const evt of events) {
    if (evt.event === "workflow.proposed") { proposed = evt.data; proposedSeq = evt.seq; }
    else if (evt.event === "workflow.updated") { updatedSeq = evt.seq; }
  }
  return proposed && proposedSeq > updatedSeq ? proposed : undefined;
}
```

This is the frontend half of PRD v1.1 Decision #1 (`03-the-core-invariant.md`): a proposal
is "pending" exactly when the latest `workflow.proposed` event's `seq` is greater than the
latest `workflow.updated` event's `seq` — i.e. it hasn't been superseded by an approval yet.
The doc comment right above it (`run-store.ts:107-116`) notes the caller should also check
`selectIsTerminal(outcome)` once the run ends (approved → `workflow.updated` +
`run.completed`; rejected → `run.completed` alone) — kept as a separate check so this stays
a pure function of `events` alone.

## `lib/sse.ts` — the transport, wrapped around the browser's native `EventSource`

```ts
// apps/frontend/src/lib/sse.ts:29-70 (openRunStream, abridged)
export function openRunStream(runId: string, handlers: RunStreamHandlers): () => void {
  const source = new EventSource(runStreamUrl(runId));
  // ...
  source.onmessage = (event) => {
    resetHeartbeatWatchdog();
    setStatus("connected");
    const parsed = JSON.parse(event.data) as RawStreamEvent;
    if (isSseEvent(parsed)) handlers.onEvent(parsed);
  };
  source.onerror = () => {
    if (closedByCaller) return;
    setStatus(source.readyState === EventSource.CONNECTING ? "reconnecting" : "closed");
  };
  return () => { closedByCaller = true; if (heartbeatTimer) clearTimeout(heartbeatTimer); source.close(); };
}
```

`EventSource` gives reconnection and `Last-Event-ID` replay for free — this module doesn't
reimplement either. What it *adds*: a heartbeat watchdog (`HEARTBEAT_TIMEOUT_MS = 20_000`,
`sse.ts:16`) that flags the connection as `"reconnecting"` if no frame (including the
backend's 15-second heartbeat, `08-api-and-runs.md`'s `runs/sse.ts`) arrives for 20 seconds
— catching the case where a silently-dead proxy leaves `readyState` at `OPEN` with no more
frames ever arriving, which `EventSource`'s own `onerror` wouldn't otherwise detect.
`isSseEvent` (`sse.ts:24-26`) filters out the heartbeat frame itself, which carries
`event: "heartbeat"` specifically so it's *not* mistaken for a real domain event.

## `useRunStream` — bridging SSE into both state systems

```ts
// apps/frontend/src/hooks/useRunStream.ts:12-40 (full hook, abridged)
export function useRunStream(conversationId: string | null, workflowId: string | null): void {
  const runId = useRunStore((s) => s.runId);
  const addEvent = useRunStore((s) => s.addEvent);
  useEffect(() => {
    if (!runId) return;
    const close = openRunStream(runId, {
      onEvent: (evt) => {
        addEvent(evt);
        if (evt.event === "workflow.updated") {
          void queryClient.invalidateQueries({ queryKey: ["workflow", workflowId] });
          void queryClient.invalidateQueries({ queryKey: ["versions", workflowId] });
        }
        if (TERMINAL_EVENTS.has(evt.event)) {
          void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
          close();
        }
      },
      onStatusChange: setConnectionStatus,
    });
    return close;
  }, [runId, conversationId, workflowId, addEvent, setConnectionStatus, queryClient]);
}
```

This one hook is where the two state systems meet: every SSE frame goes into the Zustand
store via `addEvent` (live-run state), and specific event types additionally invalidate
TanStack Query caches (server state) that the stream just made stale — a `workflow.updated`
means the cached workflow/versions are behind; any terminal event means the message list
now has the assistant's persisted reply. `Workspace.tsx` calls this hook once, at the top
level (`Workspace.tsx:47`), for whichever conversation is active.

## The three-region layout — `Workspace.tsx`

```
┌─────────────────────────────────────────────────────────┐
│ header: toggle, conversation title, ConnectionBadge,     │
│         ThemeToggle, mobile chat/workflow switch          │
├───────────────┬───────────────────────────┬──────────────┤
│ ConversationList │        ChatPane          │ WorkflowPanel│
│  (sidebar,     │  (messages + composer,    │ (graph/history│
│   toggleable)  │   flex-1)                 │   tabs, 420px)│
└───────────────┴───────────────────────────┴──────────────┘
```

`Workspace.tsx` (128 lines) owns `activeConversationId` and derives `workflowId` from
whichever conversation is active (`Workspace.tsx:44-45`). On mount, if there are zero
conversations it auto-creates one (`Workspace.tsx:25-42`) — note the
`hasRequestedCreateRef` guard specifically to survive React StrictMode's dev-mode
double-invoked effect without firing two create requests. Below `md`, the layout collapses
to a single-pane view toggled by `mobileView` (`Cmd/Ctrl+\`` is bound as a shortcut,
`Workspace.tsx:49-58`).

## The chat pane — how one turn's UI is assembled

```
ChatPane
  MessageList                     (persisted messages, from useMessages — TanStack Query)
    MessageBubble  (per message)
    RunTurn         (only for the message pair belonging to the CURRENTLY ACTIVE run)
      ActivityTimeline  (from buildTimeline(events) — lib/step-map.ts)
      MessageBubble     (streamed assistant text, until persisted)
      ApprovalPanel     (only while selectPendingProposal(events) is set)
      FailureBanner     (only if selectTerminalFailureEvent(events) is set)
  Composer                        (input box; disabled while a run owned by this conversation is active)
```

The key correctness detail, repeated in three places (`ChatPane.tsx:31`,
`MessageList.tsx:27`, and implicitly in `RunTurn`'s props): **a run belongs to whichever
conversation started it.** `runConversationId === conversationId` gates whether the
composer shows "Stop," whether `RunTurn` renders at all, and whether Escape cancels — so
switching to a different conversation while a run is in flight elsewhere never leaks that
run's live state into the wrong chat pane.

### `lib/step-map.ts`'s `buildTimeline` — the activity timeline reducer

```ts
// apps/frontend/src/lib/step-map.ts:31-129 (buildTimeline, key cases abridged)
export function buildTimeline(events, receivedAt, runTerminal, runFailed): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const callToRowKey = new Map<string, string>();
  for (const evt of events) {
    switch (evt.event) {
      case "agent.step": rows.push({ key: `step-${evt.seq}`, kind: evt.data.kind, label: evt.data.label, status: "running", seq: evt.seq }); break;
      case "tool.call": { const target = rows[rows.length - 1]; if (target) { target.toolInput = evt.data.input; callToRowKey.set(evt.data.callId, target.key); } break; }
      case "tool.result": { /* attach result/error to the row that made the call, via callId */ break; }
      case "validation.error": rows.push({ key: `verr-${evt.seq}`, kind: "validation_error", label: "Validation found problems", status: "error", seq: evt.seq, validationErrors: evt.data.errors }); break;
      // ... "retry", "provider.switched" each push their own row
    }
  }
  // Second pass: settle each row's status to "done" once a later row exists, or to "done"/"error" once the run itself is terminal.
}
```

This is a **pure reducer** — `SseEvent[]` in, `TimelineRow[]` out, no React, no I/O (the
file's own header comment, `step-map.ts:1-4`) — which is what makes replay and reconnect
trivial: reloading the page or reconnecting mid-run just re-derives the same timeline from
whatever events are in the store. `callToRowKey` (`step-map.ts:38`) is how a `tool.result`
event finds its way back to the `agent.step` row that triggered the call, via the shared
`callId` both the `tool.call` and `tool.result` events carry (`05-contract-package.md`).
`timingMs` is computed from `receivedAt` — client-side receive timestamps, since the
contract carries no server timestamp on events (`step-map.ts:20`'s doc comment).

### `ApprovalPanel` — the approval-gate UI

```tsx
// apps/frontend/src/components/chat/ApprovalPanel.tsx:17-57 (abridged)
export function ApprovalPanel({ proposal, onApprove, onReject, isResolving }) {
  return (
    <div className="...">
      <p className="font-medium">Review proposed change</p>
      <p className="text-xs text-fg-muted">{proposal.summary}</p>
      <DiffView diff={proposal.diff} />
      <button onClick={onApprove} disabled={isResolving}>Approve</button>
      <button onClick={onReject} disabled={isResolving}>Reject</button>
    </div>
  );
}
```

Rendered by `RunTurn` only while `selectPendingProposal(events)` returns something
(`RunTurn.tsx:44,60-67`). `onApprove`/`onReject` call `useApproveRun`/`useRejectRun`
(`hooks/useApproveRun.ts` — two 5-line `useMutation` wrappers around `api.approveRun`/
`rejectRun`) — note that **the panel itself never optimistically updates anything**; the
resulting `workflow.updated` (approve) or `run.completed` (reject) SSE event is what
actually drives the UI forward, via `useRunStream`'s cache invalidation. This mirrors the
backend: the frontend doesn't "decide" the outcome any more than the AI does — it makes a
REST call and waits for the SSE stream to confirm what actually happened.

### `FailureBanner` — the "no dead ends" rule

```tsx
// apps/frontend/src/components/chat/FailureBanner.tsx:57-98 (the three branches)
if (event.event === "run.timeout") return <Banner icon={Clock} tone="warning" title="...">
  <ActionButton onClick={onRetry}>Retry</ActionButton>
  {event.data.draftAvailable && <ActionButton onClick={onRetry}>Resume from draft</ActionButton>}
</Banner>;

if (event.event === "run.failed") return <Banner icon={AlertTriangle} tone="danger" title={event.data.error.message}>
  <p>The previous version was kept — nothing invalid was saved.</p>
  <ActionButton onClick={onEdit}>Edit and try again</ActionButton>
  <ActionButton onClick={onRetry}>Retry as-is</ActionButton>
</Banner>;

// run.cancelled -> a neutral "Run stopped." banner with one "Try again" action
```

The file's own header comment states the rule this component exists to enforce: **"every
failure state renders here with at least one next action"** — there is no failure outcome
in the whole system that leaves a user looking at a dead screen with nothing to click.
Notice the `run.failed` banner explicitly reassures "the previous version was kept" — a
direct, user-facing restatement of the core invariant (`03-the-core-invariant.md`): a failed
run never leaves the workflow half-changed.

## The workflow panel — graph visualization

`WorkflowPanel.tsx` (60 lines) is a two-tab switch between `WorkflowGraphView` (the React
Flow canvas) and `VersionHistory` (a list of past versions with diff/restore actions,
`components/workflow/VersionHistory.tsx`).

### `lib/dagre-layout.ts` — always auto-layout, never drag-and-drop

```ts
// apps/frontend/src/lib/dagre-layout.ts:74-86 (layoutGraph, abridged)
export function layoutGraph(graph, nodeMeta, highlight = EMPTY_HIGHLIGHT) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 32, ranksep: 64 });
  for (const node of graph.nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of graph.edges) g.setEdge(edge.source, edge.target);
  dagre.layout(g);
  // ... map dagre's computed positions into React Flow nodes, draggable: false
}
```

The file's own header comment (`dagre-layout.ts:1-4`) is explicit: **server-supplied
`node.position` is deliberately ignored** — every render re-lays-out left-to-right with
`dagre` so the user never has to manually drag nodes into a sensible arrangement (`nodes`
render with `draggable: false`, `dagre-layout.ts:111`). `edgeLabel`
(`dagre-layout.ts:60-72`) gives conditional edges (a `filter.condition` or
`schedule.weekday_filter` node) a small descriptive label like `"amount > 500"` or
`"Sat, Sun"`, read straight out of that node's `config`.

### Diff highlighting — `WorkflowGraphView`'s ghost-node trick

```ts
// apps/frontend/src/components/workflow/WorkflowGraphView.tsx:47-61 (abridged)
useEffect(() => {
  if (!diffUpdate || diffUpdate.version === lastVersionRef.current) return;
  lastVersionRef.current = diffUpdate.version;
  setGhostRemoved(diffUpdate.diff.removed.nodes);
  setHighlight({ added: new Set(...), removed: new Set(...), changed: new Set(...) });
  const timer = setTimeout(() => { setGhostRemoved([]); setHighlight(EMPTY_HIGHLIGHT); }, HIGHLIGHT_MS);
  return () => clearTimeout(timer);
}, [diffUpdate]);
```

When a `workflow.updated` event arrives (`selectLatestWorkflowUpdate`,
`run-store.ts:93`), this component briefly (`HIGHLIGHT_MS = 2600`,
`WorkflowGraphView.tsx:24`) renders **removed nodes as ghosts** — merged back into the
display graph (`displayGraph`, `WorkflowGraphView.tsx:71-77`) even though they're no longer
in the real current graph — so a user visually sees what was removed, not just what
remains, before it fades to the neutral steady state. `FitViewOnChange`
(`WorkflowGraphView.tsx:30-36`) imperatively re-fits the viewport whenever the visible node
set changes, since React Flow's own `fitView` prop only fits once on mount.

## Composer, MessageBubble, ConnectionBadge, ThemeToggle

Rounding out the UI, briefly: `Composer.tsx` is the text input + send/stop button, disabled
per the "does this run belong to this conversation" rule above. `MessageBubble.tsx`
(27 lines) renders one chat bubble, with a `tone` prop (`"pending"`/`"error"`) for
`useSendMessage`'s optimistic local bubble (`hooks/useSendMessage.ts:9-49` — the user's
message appears immediately from local component state, *not* the query cache, since it
isn't a real persisted `MessageDto` yet; on failure it gets a retry affordance instead of
vanishing). `ConnectionBadge.tsx` reflects `run-store`'s `connectionStatus` in the header.
`ThemeToggle.tsx` + `lib/theme.ts`'s `THEME_BOOT_SCRIPT` (inlined into `app/layout.tsx:16`
as a blocking `<script>`) apply the user's theme preference before first paint, avoiding a
flash of the wrong theme.

## App Router entry points

```
app/layout.tsx     Root HTML shell; injects THEME_BOOT_SCRIPT, wraps children in <Providers>
app/providers.tsx  Constructs one QueryClient (staleTime: 10s, retry: 1) for the whole app
app/page.tsx       Renders <Workspace /> — that's the entire page
```

All three are intentionally thin — `page.tsx` is 5 lines. Nearly everything this chapter
covers lives under `components/`, `hooks/`, `lib/`, and `stores/`, not `app/`.

---
**Prev:** [`09-workers.md`](./09-workers.md) · **Next:**
[`11-mock-backend.md`](./11-mock-backend.md) · **Related:**
[`05-contract-package.md`](./05-contract-package.md),
[`12-end-to-end-trace.md`](./12-end-to-end-trace.md)
