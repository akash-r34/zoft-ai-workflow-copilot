# AI Workflow Copilot: Master Plan

This is the entry point. It explains the goal, the architecture at a glance, the
technology decisions with rationale, and how the other plan files fit together.
Read this first, then execute the phases in order.

## What we are building

An AI Copilot for a Zapier / n8n style workflow automation platform. Users type
natural language ("send a Slack message whenever Stripe receives a payment") and
the Copilot creates, edits, explains, validates, and repairs workflows through a
streaming chat experience.

The brief evaluates **engineering judgement over feature completeness**, and
asks us to treat Frontend and Backend as if built by separate teams. So the plan
optimises for two things above all: defensible architectural decisions, and a
clean, documented boundary between the two sides.

This is a prototype meant to demonstrate production-grade skill, so anything that
costs money is stubbed: Stripe uses a simulated webhook, Slack and Teams are
mocked outbound sinks, and the LLM layer ships with a deterministic mock provider
so the whole system runs end to end with no API keys.

## The one idea that drives the whole design

The AI never mutates persistent state. It is a **proposer**, not a writer.

1. The agent reasons and calls tools (search nodes, read schema, propose operations).
2. It emits a set of **operations** (a patch), never raw database writes.
3. Operations pass through a **deterministic validation pipeline** (JSON Schema
   plus graph rules).
4. Only if validation passes does deterministic code apply the patch and write a
   new immutable workflow version.

This single pattern gives us safety, operation-based editing, version history, an
audit trail, and a natural place to recover from every category of LLM failure.
Every other decision in this plan flows from it.

## Architecture at a glance

```
+------------------ Frontend (Next.js) ------------------+
|  Chat pane   |  Agent activity timeline  |  Workflow   |
|              |  (steps, tools, retries)  |  viz + diff |
+---------------------------------------------------------+
        |  REST (commands, history)   |  SSE (run stream)
        v                             v
+------------------- Backend (Fastify) -------------------+
|  API layer  ->  Agent Orchestrator  ->  Tool registry   |
|                        |                     |          |
|                        v                     v          |
|              Operation validator     Node catalog (RAG) |
|              (deterministic)         pgvector search    |
|                        |                                |
|                        v                                |
|          Version applier -> Postgres (source of truth)  |
+---------------------------------------------------------+
        |                         |
        v                         v
   BullMQ workers            Redis (queue + pub/sub)
   (embeddings, heavy        bridges worker progress
    validation, lookups)      into the SSE stream
```

## Technology decisions and why

| Area | Choice | Rationale |
|------|--------|-----------|
| Repo | pnpm workspaces + Turborepo monorepo | One shared `contract` package holds the API types and schemas, enforcing the frontend/backend boundary in code. |
| Backend | Node.js + TypeScript + Fastify | First-class SSE support, schema-first validation, low overhead, clean layering without framework magic. NestJS is a fine alternative if opinionated structure is preferred. |
| Database | PostgreSQL + Prisma | Mature relational model for workflows, versions, conversations. Immutable version rows fit an event-sourced audit trail. |
| Vector search | pgvector extension | Node catalog embeddings live beside the relational data, no extra infra. Similarity queries via a small raw-SQL helper. |
| Queue / workers | BullMQ on Redis | Async embedding generation, heavy validation, external lookups. Gives retries, backoff, dead-letter queue, idempotent jobs out of the box. |
| Real-time | Server-Sent Events | The interaction is one request then a stream of server-to-client updates. SSE fits exactly, runs over plain HTTP, auto-reconnects via `EventSource`, and supports replay via `Last-Event-ID`. WebSockets add bidirectional complexity we do not need. Cancellation rides a separate REST endpoint. (Full rationale in `04-api-contract.md`.) |
| LLM | Provider abstraction + mock + Anthropic adapter | Swappable providers, circuit breaker, failover. The mock provider makes the prototype runnable with zero keys and drives failure-injection tests. |
| Validation | Ajv (JSON Schema) + custom graph validator | Node configs validate against catalog schemas; the graph validator enforces DAG rules, trigger rules, and edge type compatibility. |
| Frontend | Next.js (App Router) + React + Tailwind | Modern, familiar, good streaming ergonomics. |
| FE state | TanStack Query (server state) + Zustand (run/chat UI state) | Clean split between cached server data and live streaming UI state. |
| Workflow viz | React Flow | Lightweight node/edge rendering, exactly the "not a full editor" scope the brief allows. |
| Observability | pino structured logs + persisted run trace + optional OpenTelemetry | Every run is inspectable after the fact, which also powers the frontend timeline. |

## Prototype stubs (no real spend)

- **Stripe**: a `POST /dev/simulate/stripe-payment` endpoint emits a fake payment
  event. No real Stripe account needed. Stripe CLI listen is documented as an
  optional upgrade.
- **Slack / Teams**: outbound actions hit an internal mock sink that logs the
  message and returns success. A dummy schema mirrors the real one so validation
  is realistic.
- **LLM**: the mock provider returns scripted, deterministic tool calls so demos
  and tests are reproducible. Swap to the Anthropic adapter by setting one env var.

## Plan files and reading order

| File | Purpose |
|------|---------|
| `00-master-plan.md` | This file. Goals, architecture, decisions. |
| `01-phase0-setup.md` | Skills discovery, monorepo scaffold, tooling, Docker base. |
| `02-backend.md` | Domain model, validation pipeline, agent orchestration, async, reliability. Backend build phases. |
| `03-frontend.md` | Chat UX, streaming, agent visibility, workflow viz, failure states. Frontend build phases. |
| `04-api-contract.md` | The documented contract: REST endpoints, SSE event schema, error model. The seam between the two teams. |
| `05-deliverables.md` | Dockerisation, architecture docs, READMEs, demo video script, evaluation-mapping checklist. |

## Phase map (top level)

- **Phase 0** Foundation: skills, monorepo, shared contract, Docker base.
- **Phase 1** Backend domain: schema, node catalog, operations, deterministic validator.
- **Phase 2** Backend AI: provider abstraction, agent loop, RAG, bounded self-correction.
- **Phase 3** Backend runtime: SSE streaming, workers, cancellation, circuit breaker, DLQ.
- **Phase 4** Frontend core: chat, history, SSE client, optimistic updates, activity timeline.
- **Phase 5** Frontend advanced: workflow viz, diff view, version history, all failure states.
- **Phase 6** Hardening: Docker, docs, observability, demo video.

Each phase has independently verifiable acceptance criteria stated in its file.
Do not advance to the next phase until the current one meets its criteria.

## Guiding principles for every phase

1. The AI proposes, deterministic code disposes. No AI write path to the database.
2. Every workflow change is a new immutable version with a change summary and author.
3. Node definitions are data, not code. New nodes appear without a redeploy.
4. Every failure mode has a named, tested recovery path.
5. The frontend and backend only ever talk through the documented contract.
6. Clean code standards throughout: typed boundaries, small pure functions for
   validation, adapters behind interfaces, no secrets in code, tests on the
   deterministic core.
