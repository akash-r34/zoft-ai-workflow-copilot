# Skills Report

Skill discovery performed using `npx skills find` (via the `find-skills` skill
installed from `https://github.com/vercel-labs/skills`).

Install command form: `npx skills add <owner/repo@skill>`

---

## Search: fastify

**Skill:** `mcollina/skills@fastify-best-practices` — 18.2K installs; best-practices for
Fastify from Matteo Collina (Fastify core maintainer). Applies to the `apps/backend`
Fastify server throughout all phases.
Install: `npx skills add mcollina/skills@fastify-best-practices`

Other results: `mindrally/skills@fastify-typescript` (606), `auth0/agent-skills@auth0-fastify-api` (494).

---

## Search: prisma postgres

**Skill:** `prisma/skills@prisma-database-setup` — 13.3K installs; Prisma ORM setup
and schema patterns. Directly relevant to Phase 1 (`apps/backend/prisma/schema.prisma`,
migrations, Postgres domain model).
Install: `npx skills add prisma/skills@prisma-database-setup`

**Skill:** `prisma/skills@prisma-postgres` — 8.3K installs; Prisma + Postgres specific
patterns. Covers immutable version rows and the operation log structure.
Install: `npx skills add prisma/skills@prisma-postgres`

---

## Search: bullmq redis

**Skill:** `sickn33/antigravity-awesome-skills@bullmq-specialist` — 1.4K installs;
BullMQ job queue patterns. Applies to Phase 3 background workers (embedding generation,
async validation, DLQ).
Install: `npx skills add sickn33/antigravity-awesome-skills@bullmq-specialist`

Other results: `davila7/claude-code-templates@bullmq-specialist` (329),
`patricio0312rev/skills@queue-job-processor` (186).

---

## Search: server-sent events

**Skill:** `aj-geddes/useful-ai-prompts@real-time-features` — 473 installs; real-time
streaming patterns. Applies to Phase 3 SSE run stream (Fastify SSE endpoint +
`Last-Event-ID` replay).
Install: `npx skills add aj-geddes/useful-ai-prompts@real-time-features`

**Skill:** `dadbodgeoff/drift@sse-streaming` — 100 installs; SSE-specific streaming.
Install: `npx skills add dadbodgeoff/drift@sse-streaming`

---

## Search: pgvector embeddings

**Skill:** `timescale/pg-aiguide@pgvector-semantic-search` — 549 installs; pgvector
semantic search patterns. Applies to Phase 2 node catalog RAG (similarity search over
node definitions stored in Postgres with the `vector` extension).
Install: `npx skills add timescale/pg-aiguide@pgvector-semantic-search`

**Skill:** `yonatangross/orchestkit@rag-retrieval` — 759 installs; RAG retrieval patterns.
Install: `npx skills add yonatangross/orchestkit@rag-retrieval`

---

## Search: llm tool calling

**Skill:** `posthog/skills@exploring-llm-traces` — 143 installs; LLM trace inspection.
Useful for the Phase 2 agent orchestrator's tool-call trace stored in Postgres (powers
the frontend activity timeline).
Install: `npx skills add posthog/skills@exploring-llm-traces`

Note: No high-install-count skill found specifically for structured tool-calling/function
calling patterns. General agent orchestration will rely on the Anthropic SDK docs directly.

---

## Search: next.js app router

**Skill:** `wshobson/agents@nextjs-app-router-patterns` — 22.8K installs; the dominant
Next.js App Router skill. Applies to `apps/frontend` throughout Phases 4–5 (Server
Components, streaming, route handlers).
Install: `npx skills add wshobson/agents@nextjs-app-router-patterns`

**Skill:** `wsimmonds/claude-nextjs-skills@nextjs-app-router-fundamentals` — 2.1K installs;
fundamentals and common patterns.
Install: `npx skills add wsimmonds/claude-nextjs-skills@nextjs-app-router-fundamentals`

---

## Search: docker compose

**Skill:** `manutej/luxor-claude-marketplace@docker-compose-orchestration` — 1.9K installs;
Docker Compose orchestration. Relevant to Phase 6 multi-service Dockerfile + Compose
production stack.
Install: `npx skills add manutej/luxor-claude-marketplace@docker-compose-orchestration`

Other results: `thebushidocollective/han@docker-compose-production` (295),
`bagelhole/devops-security-agent-skills@docker-compose` (118).

---

## Recommended installs for this project

| Phase | Skill | Reason |
|-------|-------|--------|
| 1 | `prisma/skills@prisma-database-setup` | Schema design, migrations |
| 2 | `timescale/pg-aiguide@pgvector-semantic-search` | Node catalog RAG |
| 3 | `mcollina/skills@fastify-best-practices` | SSE + API layer |
| 3 | `sickn33/antigravity-awesome-skills@bullmq-specialist` | Background workers |
| 4–5 | `wshobson/agents@nextjs-app-router-patterns` | Frontend App Router |
| 6 | `manutej/luxor-claude-marketplace@docker-compose-orchestration` | Production compose |
