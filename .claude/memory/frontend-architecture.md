# `apps/frontend` — architecture detail

Referenced from the root `CLAUDE.md`. Not yet implemented beyond the Phase 0 scaffold
(Next.js 14 App Router, one placeholder page/test) — this is the design target for
Phases 4–5.

## State split (strict separation)

- **TanStack Query** — server state: conversations, messages, workflow, version list.
  Cached, refetchable, source of truth for persisted data.
- **Zustand** — live run state: active `runId`, ordered event list, token buffers,
  connection status. Ephemeral UI state only.

Never mix these. Live streaming state goes to Zustand; anything that should survive a
page refresh goes through TanStack Query.

## SSE consumption

Reduce events into the Zustand run store **by `seq`**. Rendering is a pure function of
the ordered event list. On reconnect send `Last-Event-ID: <last seq seen>`. A heartbeat
event absence flips the UI to "reconnecting".

## Three-region layout

- **Chat pane** (center-left) — conversation, streaming tokens, input.
- **Agent activity timeline** (attached to the in-flight turn) — collapsible rows per
  step, expandable for tool input/result/timing.
- **Workflow panel** (right) — React Flow graph, diff highlighting on
  `workflow.updated`, version history control.

## Workflow visualisation

React Flow, read-mostly. Auto-layout (dagre, left-to-right). No manual dragging. On
`workflow.updated`: added nodes/edges glow green, removed fade red, changed config
pulses amber; diff persists briefly then settles to neutral.

## Failure state rule

**No dead ends.** Every failure state (`run.timeout`, `run.failed`, `validation.error`,
`provider.switched`, `retry`) must offer a next action (retry, resume, view details).
