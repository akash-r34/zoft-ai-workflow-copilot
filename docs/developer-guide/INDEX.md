# Zoft AI Workflow Copilot — Developer Guide

**A natural-language AI assistant for building Zapier/n8n-style automation workflows.**
Type "send a Slack message whenever Stripe receives a payment," watch the AI reason and
propose a change, approve it, and see your workflow update live.

This guide is written for a developer who has never seen this codebase before. Read it
start to finish (a few hours) and you should be able to navigate and modify any part of the
system unaided — every chapter cites concrete files and line numbers, not just concepts.

## How to use this guide

- **Anchored to commit `8df9601`.** Every `file/path.ts:NN` reference is paired with a
  symbol name (a function, type, or constant) — if a line number has drifted since this was
  written, grep the codebase for that symbol name; the reference is still trustworthy, the
  line number is just a convenience.
- **Code excerpts are real, pulled verbatim from the source**, followed by plain-English
  explanation — not paraphrased pseudocode.
- Each chapter ends with **Prev / Next / Related** links so the set reads like a book, but
  every chapter is also written to stand alone if you jump straight to it.
- This guide **complements, and deliberately does not duplicate**, two existing docs:
  - [`../architecture.md`](../architecture.md) — a shorter, outside-reader-facing system
    design doc with the same core invariant, aimed at someone who wants the shape of the
    system without the file-by-file depth this guide provides.
  - [`../api.md`](../api.md) — the generated-from-what's-actually-implemented REST + SSE
    endpoint reference. Chapter 08 here explains the *code paths* behind those endpoints and
    links out to `api.md` for the table itself, rather than restating it.
  - The repo root's `CLAUDE.md` and `REMAINING.md` are the terse, AI-assistant-facing
    equivalents of chapters 02 and parts of 14/15 — worth skimming, but this guide is the
    one meant for a human reading start to finish.

## Reading paths

**Fast track** (get productive in under an hour): `00` → `01` → `03` → `12`. This gets you
the product story, a running app, the one invariant that explains every design decision,
and one fully-traced request across the whole stack.

**Full depth** (recommended before your first real change): read every chapter in numeric
order, `00` through `15`.

## Table of contents

| # | Chapter | What you'll learn |
|---|---|---|
| — | **[This file]** | Master index, legend, reading paths |
| 00 | [Orientation](./00-orientation.md) | The product, a walkthrough, the mental model, a full glossary — no code |
| 01 | [Getting Started](./01-getting-started.md) | Three ways to run it locally, verifying it works, running tests |
| 02 | [Repo Map and Conventions](./02-repo-map.md) | Monorepo layout, the contract-package rule, TypeScript/lint conventions, CI |
| 03 | [The Core Invariant](./03-the-core-invariant.md) | **The keystone chapter** — AI proposes, deterministic code validates and writes, traced through real code |
| 04 | [The Data Model](./04-data-model.md) | Every Prisma model, why versions are immutable, migrations |
| 05 | [The Contract Package](./05-contract-package.md) | The shared types both apps import — graphs, operations, SSE events, DTOs, errors |
| 06 | [The Deterministic Core](./06-deterministic-core.md) | `applyOperations`, `validateGraph`, `applyVersion` — the safety heart, function by function |
| 07 | [The Agent Loop, Providers, and Tools](./07-agent-and-providers.md) | The orchestrator, `LlmProvider`, `MockProvider`'s scripts, the circuit breaker, the four tools, pgvector RAG |
| 08 | [The API Server, Runs, and Real-Time Delivery](./08-api-and-runs.md) | Fastify wiring, the run lifecycle, Redis pub/sub + atomic seq, the SSE stream handler |
| 09 | [Background Workers](./09-workers.md) | BullMQ scaffolding, the embedding/validation/archival workers, each checked against the core invariant |
| 10 | [The Frontend](./10-frontend.md) | TanStack Query vs Zustand, the three-region layout, SSE consumption, timeline, graph viz, approval UI, failure states |
| 11 | [The Mock Backend](./11-mock-backend.md) | Why a second backend implementation exists, how it differs, when to use which |
| 12 | [End-to-End Trace](./12-end-to-end-trace.md) | **The payoff chapter** — one message traced hop-by-hop across the entire stack |
| 13 | [Testing](./13-testing.md) | The four test tiers, why integration tests use a dedicated gate flag, testing patterns worth reusing |
| 14 | [Operations, Docker, and Configuration](./14-ops-and-docker.md) | Full env-var reference, three ways to run locally, Docker internals, troubleshooting |
| 15 | [Extending the System: Recipes](./15-extending.md) | Six step-by-step recipes for common changes, each checked against the core invariant |

## The one idea to hold onto

Before reading anything else, internalize this — it's the answer to "why is this file
shaped this way" for almost everything you'll encounter:

> **The AI proposes operations. Deterministic code validates and applies them.
> The AI never writes to the database directly.**

Chapter 03 is the full treatment. Every other chapter either builds up to this gate or
builds on top of it.
