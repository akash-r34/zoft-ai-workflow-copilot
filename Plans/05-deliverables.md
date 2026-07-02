# Phase 6: Deliverables, Docker, Docs, Demo

This phase turns a working system into a submittable package. The brief lists
exact deliverables; this file maps each one to a concrete task and closes with a
checklist that traces every requirement to where it is satisfied.

---

## Dockerisation

Both apps ship Dockerised, plus a compose file that runs the whole system.

- `apps/backend/Dockerfile`: multi-stage (build then slim runtime), runs
  migrations on start, non-root user.
- `apps/frontend/Dockerfile`: multi-stage Next.js build, standalone output.
- `infra/docker-compose.yml`: `postgres` (vector extension), `redis`, `backend`,
  `worker` (same image as backend, different command), `frontend`. Healthchecks
  and depends_on ordering so `docker compose up` yields a working app with no
  manual steps.
- `.env.example` for each app. The mock LLM provider is the default so the stack
  runs with zero external keys. A documented single env var switches to the
  Anthropic adapter.

**Acceptance**: a clean checkout plus `docker compose up` gives a fully working
Copilot at a documented URL, no API keys required.

---

## Architecture documentation (backend)

`docs/architecture.md` covering:

- The "AI proposes, deterministic code disposes" principle and why it exists.
- The domain model and the immutable version history.
- The agent loop, tool set, and RAG node retrieval.
- The reliability table (failure mode to recovery), reproduced with the actual
  code paths.
- The async runtime: runs, SSE, workers, queue, DLQ, circuit breaker.
- Scale posture for the brief's numbers (100k workflows, 10k conversations/day).
- A sequence diagram for one full run: message in, agent loop, validation,
  version persisted, events streamed out.

Keep prose plain and hyphenated only.

---

## Frontend README (major UI decisions)

`apps/frontend/README.md` explaining, with reasons:

- Why SSE consumption and how reconnect/replay works.
- The three-region layout and progressive-disclosure activity timeline.
- State split: TanStack Query for server state, Zustand for live run state.
- Diff highlighting and the read-mostly React Flow visualisation.
- The failure-state design and the "no dead ends" rule.

---

## API documentation

`docs/api.md` is `04-api-contract.md` promoted to a standalone reference: every
REST endpoint with request and response examples, the full SSE event catalogue,
the error model, and the reconnect/replay protocol. State explicitly that a team
can build either side from this document alone. Optionally generate an OpenAPI
spec for the REST surface from the Fastify schemas.

---

## Demo video (5 to 10 minutes)

Script it so every required capability is shown on camera in order:

1. **Create** (0:00-1:30): "Send a Slack message whenever Stripe receives a
   payment." Narrate the streaming steps as they appear (planning, searching
   nodes, reading schema, validating). Show the workflow render.
2. **Edit / provider swap** (1:30-3:00): "Replace Slack with Microsoft Teams."
   Point at the animated diff (Slack node out, Teams node in).
3. **Conditional edit** (3:00-4:00): "Only notify for payments above $500," then
   "only on weekdays." Show the filter and weekday nodes appear.
4. **Explain and why** (4:00-5:00): "Explain this workflow," then "why did you
   make that change?" Show answers drawn from version history.
5. **Streaming and tool visibility** (5:00-6:00): expand a timeline step to reveal
   the tool input and result; show token-by-token prose.
6. **Validation** (6:00-7:00): trigger a validation error (mock provider proposes
   a bad config or hallucinated node), show it caught, show the AI self-correct.
7. **Failure handling** (7:00-8:30): force a provider outage to show failover;
   cancel a run mid-flight; kill and restore the network to show reconnect and
   replay.
8. **Close** (8:30-9:00): one line on the architecture principle that made all of
   this safe: the AI never wrote to the database directly.

Record at a readable resolution, keep narration tight, and cut dead air.

---

## Requirement-to-implementation checklist

Use this as the final gate before submission.

### Backend
- [ ] Own workflow representation (graph of typed nodes and edges). `02-backend.md` s.1
- [ ] Create / modify / explain / validate / recover. s.2, s.3
- [ ] AI never mutates state; validation gates every write. s.2
- [ ] New node definitions without redeploy (data-driven catalog). s.1
- [ ] All seven LLM failure modes handled and tested. s.5
- [ ] Persist workflows, conversations, versions, metadata. s.1
- [ ] Scale posture for the stated numbers. s.6
- [ ] Async processing (workers, queue, embeddings). s.4
- [ ] Extensible: node types, providers, tools, engines. s.1, s.3
- [ ] Dockerised backend. this file

### Frontend
- [ ] Chat-based Copilot with maintained context. `03-frontend.md` s.1, s.7
- [ ] Real-time via SSE, with justification. s.3, `04-api-contract.md`
- [ ] Streaming "working" experience. s.4
- [ ] Agent visibility without overwhelm. s.5
- [ ] Lightweight workflow visualisation. s.6
- [ ] Conversation history and natural follow-ups. s.7
- [ ] All failure states designed. s.8
- [ ] Loading, optimistic, retry, long-running, cancel, reconnect. s.9
- [ ] Dockerised frontend + README of UI decisions. this file

### Shared and submission
- [ ] Documented contract; either side buildable alone. `04-api-contract.md`
- [ ] Architecture docs, frontend README, API docs. this file
- [ ] `docker compose up` runs the whole system with no keys. this file
- [ ] Demo video covering create, edit, streaming, tool visibility, validation,
      failure handling. this file

### Optional enhancements already designed in
Tool calling, agentic planning, RAG, conversation memory, operation-based
editing, background workers, event sourcing (immutable versions), audit history,
prompt versioning, multi-provider LLM, dead-letter queue, idempotent jobs,
circuit breakers, cost tracking, live token streaming, tool execution timeline,
expandable reasoning steps, diff view, version history, stop generation, resume
after reconnect, multi-session chat, toast notifications, progressive rendering,
keyboard-first, dark mode. Implement as time allows; the architecture already
accommodates each.
