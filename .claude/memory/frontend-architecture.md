# `apps/frontend` — architecture detail

Referenced from the root `CLAUDE.md`. Implemented (Phases 4–5, done out of order —
see `.claude/memory/build-phases.md` and `PHASE4_5_DONE.md`) against a self-contained
mock backend (`apps/frontend/mock/`, a real peer implementation of
`packages/contract`'s REST + SSE surface, not a stub). Everything below describes
what's actually built, not just the design target.

## Mock backend (`apps/frontend/mock/`)

Dev-only, not part of the Phase 6 production Docker target. Fastify server:
- `server.ts` — every route in `Plans/04-api-contract.md` on port 3001, mapping
  private storage rows (`types.ts`) to real `@zoft/contract` DTOs at the boundary.
- `scenarios.ts` — the scripted "AI": keyword-matches the user's message to one of
  the six brief scenarios or five failure injections (see `PHASE4_5_DONE.md` for the
  full list and trigger words), emits a paced SSE sequence through the same
  `store.ts` event log a real run would use.
- `store.ts`, `catalog.ts`, `graph-ops.ts`, `persistence.ts` — in-memory state, the
  five-entry node catalog (mirrors `apps/backend/prisma/seed.ts`), pure graph
  diff/clone helpers, and a gitignored JSON snapshot so the mock survives a restart.

Swapping to a real backend is a `NEXT_PUBLIC_API_URL` change only — nothing in
`src/` imports from `mock/`.

## State split (strict separation)

- **TanStack Query** (`src/hooks/*`) — server state: conversations, messages,
  workflow, version list, node catalog. Cached, refetchable, source of truth for
  persisted data. Invalidated where an SSE event implies the server changed (e.g.
  `workflow.updated` → invalidate `workflow`/`versions`).
- **Zustand** (`src/stores/run-store.ts`) — live run state: active `runId`, the
  `conversationId` it belongs to (so a run never leaks into a different
  conversation), the ordered `SseEvent[]` deduped by `seq`, connection status,
  derived outcome. Ephemeral UI state only — nothing here survives a page refresh.

Never mix these. Live streaming state goes to Zustand; anything that should survive
a page refresh goes through TanStack Query.

## SSE consumption

`src/lib/sse.ts` wraps `EventSource`; `src/hooks/useRunStream.ts` bridges it into
the run store. Reduce events into the Zustand run store **by `seq`**
(`stores/run-store.ts`'s `addEvent`, deduped against replay). Rendering — the
timeline (`src/lib/step-map.ts`), the streamed prose, the workflow diff — is a pure
function of that ordered event list, unit-tested without any DOM. On reconnect
`EventSource` sends `Last-Event-ID: <last seq seen>` automatically; a heartbeat
absence for 20s flips the UI to "reconnecting" (`src/components/ui/ConnectionBadge.tsx`).

## Three-region layout

`src/components/Workspace.tsx` plus:
- **Chat pane** (center-left, `chat/`) — `MessageList`, `Composer` (controlled,
  Enter/Shift+Enter, Stop button replaces Send while running, Escape cancels).
- **Agent activity timeline** (`chat/RunTurn.tsx` + `timeline/`) — attached to the
  in-flight turn, collapsible rows per step, expandable for tool input/result/an
  approximate timing (derived from client receive timestamps — the contract carries
  no server timestamp). A row auto-expands the moment it turns into an error.
- **Workflow panel** (right, `workflow/`) — tabs between the live graph
  (`WorkflowGraphView.tsx`) and version history (`VersionHistory.tsx` + `DiffView.tsx`).
  Collapses into a tab on narrow screens (`mobileView` state in `Workspace.tsx`,
  toggleable via `Cmd/Ctrl+\`).
- **Conversation sidebar** (left, `Sidebar/ConversationList.tsx`) — optional
  multi-session switcher; toggleable via the panel-left button in the header.

## Workflow visualisation

`@xyflow/react`, read-mostly (`nodesDraggable`/`nodesConnectable`/`elementsSelectable`
all off). Auto-layout via `src/lib/dagre-layout.ts` (`@dagrejs/dagre`, left-to-right,
server `position` ignored, unit-tested for determinism). Custom node renderer
(`workflow/WorkflowNodeCard.tsx`) shows display name, provider, config summary.
Conditional edges (`filter.condition`, `schedule.weekday_filter` sources) carry a
small label.

On `workflow.updated`: added and changed nodes glow in place (green/amber ring,
CSS `animate-diff-*` classes in `tailwind.config.ts`, 2.6s); removed nodes render as
temporary "ghost" cards (fading red) since they're no longer in the current graph —
the one case where the panel briefly shows more than the literal current graph.
Because the graph can grow upstream of the trigger, the viewport re-fits
imperatively on node-set change (`FitViewOnChange` in `WorkflowGraphView.tsx`)
rather than relying on React Flow's mount-only `fitView` prop.

## Failure state rule

**No dead ends** (`src/components/chat/FailureBanner.tsx`). Every non-success
terminal outcome (`run.timeout`, `run.failed`, `run.cancelled` — `validation.error`
and `retry` render as timeline rows, not banners, since the run continues past them)
renders a banner with at least one next action: Retry / Resume from draft (timeout),
Edit-and-retry (prefills the composer) / Retry-as-is (failed), Try again (cancelled).
`provider.switched` is a quiet inline timeline row, not a banner. See `PHASE4_5_DONE.md`
for why Retry and Resume are currently equivalent (the mock has no separate
uncommitted draft state to resume from).
