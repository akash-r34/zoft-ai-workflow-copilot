# `apps/frontend` — Zoft AI Workflow Copilot UI

An AI-native chat product (Next.js 14 App Router) for building automation workflows
through natural language, implementing `Plans/03-frontend.md`. This README covers the
major UI decisions and why; for the full architecture reference see
`.claude/memory/frontend-architecture.md`.

## Running it

The real backend's AI/runtime phases (`Plans/02-backend.md` phases 2–3) aren't built
yet, so this app talks to a **self-contained mock backend** (`mock/`) that implements
the real `packages/contract` REST + SSE surface against an in-memory store. This keeps
the frontend's team boundary honest: it only ever talks through the documented
contract, and is fully demoable with zero dependency on the real backend.

```bash
pnpm --filter @zoft/contract build   # once
pnpm --filter @zoft/frontend dev     # Next on :3000, mock backend on :3001
```

Swapping to the real backend later is a one-line change: point `NEXT_PUBLIC_API_URL`
at it. Nothing in `src/` imports from `mock/`.

## Why SSE, and how reconnect/replay works

The AI run is one request followed by a stream of server-to-client updates (steps,
tokens, workflow diffs, completion) — a unidirectional push, which is exactly what
Server-Sent Events are for (full rationale: `Plans/04-api-contract.md`). The payoff for
the frontend: `EventSource` (`src/lib/sse.ts`) gives reconnection and replay for free.
Every event carries a monotonic `seq`; the browser automatically resends the last
received `seq` as `Last-Event-ID` on reconnect, and the server replays only what was
missed. The client never has to de-duplicate by hand beyond a cheap `seq` set-check in
the run store — that guard exists only to be safe against a slow double-delivery, not
because the protocol requires it.

A heartbeat watchdog (`HEARTBEAT_TIMEOUT_MS` in `lib/sse.ts`) flips a `connectionStatus`
to `"reconnecting"` if no frame arrives for 20s, surfaced as a quiet badge
(`components/ui/ConnectionBadge.tsx`) rather than an alarming error — the connection
usually recovers on its own.

## State split: TanStack Query vs. Zustand

- **TanStack Query** (`src/hooks/*`) owns everything persisted: conversations,
  messages, the workflow and its versions, the node catalog. Cached, refetchable,
  invalidated when an SSE event implies the server changed (e.g. `workflow.updated`
  invalidates the `workflow`/`versions` queries).
- **Zustand** (`src/stores/run-store.ts`) owns only the live run: the active `runId`,
  the ordered SSE event log, a connection status, and the derived outcome. It is
  explicitly scoped to the conversation that started it (`conversationId` on the
  store) so that switching conversations mid-run never leaks one conversation's live
  timeline into another's chat pane.

Rendering the timeline, the streamed assistant prose, and the workflow diff highlight
are all **pure functions of the ordered event list** (`lib/step-map.ts`,
`lib/dagre-layout.ts`) — replay and reconnect fall out of that for free, and the same
functions are unit-tested without any DOM or network.

## Three-region layout and progressive disclosure

Chat pane (center-left) with the activity timeline inline in the in-flight turn,
workflow panel (right, tabs between the live graph and version history), and an
optional conversation sidebar (left) for multi-session use. The workflow panel
collapses into a tab on narrow screens.

The activity timeline is deliberately boring by default: one compact row per step
(icon, label, status), collapsed. Expanding a row reveals the tool input/result,
validation errors, and an approximate timing — full transparency on demand, without
making the common case noisy. A row auto-expands the moment it turns into an error, so
the user doesn't have to go hunting for what went wrong.

## Diff highlighting and the read-mostly graph

`@xyflow/react` renders nodes as cards (display name, provider, config summary);
`@dagrejs/dagre` re-lays-out the graph left-to-right on every render, so the user never
drags a node — this is the "lightweight, not a full editor" scope the brief allows.
`nodesDraggable`/`nodesConnectable`/`elementsSelectable` are all off.

On `workflow.updated`, added/removed/changed node ids are diffed against the
just-fetched graph: added and changed nodes glow in place (they're already in the
current graph), while removed nodes are rendered as temporary "ghost" cards fading out
for ~2.6s before disappearing — this is the one case where the panel briefly shows more
than the literal current graph, specifically so a removal is visible at all. Because
the graph can grow upstream of the trigger (e.g. a filter inserted between the trigger
and the rest), the view refits the viewport imperatively whenever the visible node set
changes, rather than relying on React Flow's mount-only `fitView`.

## The failure-state design and "no dead ends"

Every terminal run outcome that isn't a clean success renders a banner
(`components/chat/FailureBanner.tsx`) with at least one next action — this is the
literal rule from `03-frontend.md` section 8:

| Outcome | Banner | Next action(s) |
|---|---|---|
| `run.timeout` | "The Copilot took too long." | Retry, and Resume from draft if the run signaled one was available |
| `run.failed` | The plain-language validation error | Edit and try again (prefills the composer so the user can adjust the request), or retry as-is |
| `run.cancelled` | "Run stopped." | Try again |

A validation failure never leaves a partial write: the mock (like the real backend
would) never calls its version-applier until validation passes, so "the previous
version was kept" is always literally true, not just a UI claim.

The mock has no separate uncommitted "draft" state to resume from (nothing is written
until it validates), so today Retry and Resume both just resend the original request —
a real backend that preserved actual partial agent state could make Resume skip
straight to it without re-running the earlier steps.

Cancellation (`Escape`, or the Stop button that replaces Send while a run is active)
calls `POST /runs/:id/cancel` and reflects `run.cancelled` as soon as the event arrives
— usually under a second against the mock's step cadence.
