# Frontend: Copilot Experience

The frontend is an AI-native chat product in the spirit of Cursor, Claude, and
ChatGPT. The goal is thoughtful interaction design for an AI system, not visual
polish. It talks to the backend only through the contract in `04-api-contract.md`.

The hardest UX problem here is legibility under uncertainty: the user must always
understand what the AI is doing, including while it works, when it retries, and
when it fails. Every decision below serves that.

---

## 1. Layout

A three-region workspace:

- **Chat pane** (center-left): the conversation. User and assistant messages,
  streaming tokens, follow-up input.
- **Agent activity timeline** (attached to the in-flight assistant turn): the live
  view of what the AI is doing, expandable per step.
- **Workflow panel** (right): the current workflow visualisation with diff
  highlighting, plus a version history control.

On narrow screens the workflow panel collapses into a tab. The timeline stays
inline with its message so history remains readable after the run ends.

---

## 2. State management

- **TanStack Query** for server state: conversations, messages, workflow, version
  list. Cached, refetchable, the source of truth for anything persisted.
- **Zustand** for live run state: the active `runId`, the ordered stream of run
  events, streaming token buffers, connection status. This is ephemeral UI state
  distinct from cached server data.

Separating these two prevents the classic mess where live streaming state fights
with cached query state.

---

## 3. Real-time consumption (SSE)

- Open the run stream with `EventSource` (or a fetch-based SSE reader if custom
  headers are needed) on `GET /runs/:runId/stream`.
- Reduce each event into the Zustand run store by `seq`. Rendering is a pure
  function of the ordered event list, which makes replay and reconnect trivial.
- Track the last `seq` seen. On reconnect, pass `Last-Event-ID` so the backend
  replays only missed events. No duplicates, no gaps.
- A heartbeat event keeps the connection warm and lets the UI show a live
  "connected" indicator; its absence flips the UI to "reconnecting".

Why SSE and not WebSockets is argued in `04-api-contract.md`; the frontend
consequence is simpler client code and free reconnection.

---

## 4. The streaming experience

The user should watch the Copilot work, not stare at a spinner. Map backend
events to visible progress:

```
Planning workflow...          <- run.started / agent.step:planning
Searching available nodes...  <- tool.call:search_nodes
Reading Slack schema...       <- tool.call:get_node_schema
Calling validator...          <- validation.progress
Fixing missing configuration  <- retry / agent.step:repair
Generating workflow...        <- agent.step:proposing
Done.                         <- run.completed
```

Assistant explanation text streams token by token as `token` events arrive.
Progress steps and streamed prose coexist: steps show the machinery, prose shows
the answer.

---

## 5. Agent visibility without overwhelm

The activity timeline is a vertical list of steps. Each step is one compact row:
an icon for its kind (plan, search, read schema, validate, propose, retry), a
short label, and a status (running, done, error). Rows are collapsed by default.

Expanding a row reveals the detail: the tool input, the tool result (for example
the node types `search_nodes` returned, or the exact validation errors), and
timing. This is the progressive-disclosure pattern: a calm summary by default,
full transparency on demand. Retries render as their own rows with a clear
"retrying (attempt 2 of 3)" label so the user sees recovery happening rather than
a stall.

---

## 6. Workflow visualisation

- **React Flow**, read-mostly. Nodes render as cards showing display name,
  provider, and a config summary. Edges show direction; conditional edges (for
  example "amount > 500") carry a small label.
- **Diff highlighting**: on a `workflow.updated` event carrying the diff, animate
  changes in place. Added nodes and edges glow green, removed ones fade red,
  changed configs pulse amber. The diff persists briefly so the user can see
  exactly what the AI did, then settles to neutral.
- Layout is auto-arranged (a simple left-to-right dagre pass) so the user never
  has to drag nodes. This honours the "lightweight, not a full editor" scope.

---

## 7. Conversation history and follow-ups

- The full message list is scrollable and revisitable. Past assistant turns keep
  their (now collapsed) activity timelines, so any earlier run stays inspectable.
- Follow-ups work naturally because the backend keeps conversation context: the
  user just keeps typing ("actually use Teams instead", "only on weekdays") and
  each turn operates on the current workflow.
- Optional multi-session: a conversation switcher in a sidebar. Each conversation
  maps to a workflow.

---

## 8. Failure states (the UI must always explain what is happening)

| Situation | Backend signal | UI treatment |
|-----------|----------------|--------------|
| AI timeout | `run.timeout` | Inline banner on the turn: "The Copilot took too long." Buttons: Retry, Resume from draft. |
| Invalid workflow | `validation.error` | An errors card listing each error against its node, with the AI's repair attempt shown as a following step. |
| Validation failure (final) | `run.failed` with validation errors | The proposed change is not applied; the prior version stays intact; the errors are explained in plain language. |
| Tool failure | `tool.result` with error | The failing step turns red and expands to show the error; the run continues if recoverable. |
| Retrying | `retry` | A "retrying (n of m)" row; the compose box stays disabled with a subtle progress hint. |
| Partial completion | `run.timeout` or `run.cancelled` with a draft | A "draft available" affordance; nothing is silently persisted. |
| Provider switched | `provider.switched` | A quiet inline note ("switched AI provider, continuing") so the recovery is legible, not hidden. |

Guiding rule: no dead ends. Every failure state offers the next action (retry,
resume, edit the request, or view details).

---

## 9. Core interaction UX

- **Optimistic user messages**: the user's message appears instantly; if the run
  fails to start, it is marked with a retry affordance.
- **Loading states**: skeletons for history load; the activity timeline itself is
  the loading state for a run (never a bare spinner).
- **Stop generation**: a Stop button during any active run calls
  `POST /runs/:id/cancel`; the UI reflects `run.cancelled` immediately.
- **Reconnect after network loss**: automatic, via `EventSource` plus
  `Last-Event-ID` replay. A transient "reconnecting" indicator, then seamless
  resume.
- **Keyboard-first**: Enter to send, Shift+Enter for newline, Escape to stop a
  run, a shortcut to toggle the workflow panel.
- **Dark mode**: optional, low cost with Tailwind; ship it if time allows.

---

## Frontend build phases

### Phase 4: Chat core and streaming
- Next.js app shell, three-region layout, TanStack Query + Zustand wiring.
- Conversation load, send message, create and open a run.
- SSE client, event reducer, streaming tokens, optimistic user messages.
- Activity timeline with collapse/expand and step statuses.
- **Acceptance**: a user can create a workflow through chat and watch every step
  stream in; the assistant's explanation streams token by token; history reloads
  correctly.

### Phase 5: Visualisation and resilience
- React Flow workflow panel with auto-layout and diff highlighting on
  `workflow.updated`.
- Version history control and a version-to-version diff view.
- All failure states from section 8, plus Stop, reconnect with replay, and
  resume-from-draft.
- **Acceptance**: swapping Slack for Teams shows an animated diff; every failure
  state is reachable and each offers a next action; killing the network mid-run
  and restoring it resumes with no gaps or duplicate messages; Stop halts a run
  cleanly.
