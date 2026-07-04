# Remaining work

As of this pass, essentially everything in this file's previous version has been
built: pgvector RAG, BullMQ workers (embedding, catalog-integrity validation,
version archival), a Redis pub/sub SSE bridge with an atomic cross-process seq
counter, a real `ProviderRouter` + circuit breaker, and all of Phase 6 (production
Dockerfiles, `docker compose up` packaging, `docs/architecture.md`, `docs/api.md`, a
recorded demo video). See `.claude/memory/build-phases.md` for the full decision log
and `docs/architecture.md` for how it all fits together.

**One item remains genuinely outstanding, by deliberate choice:**

## `AnthropicProvider` — not built

A real `@anthropic-ai/sdk`-backed `LlmProvider` needs a paid `ANTHROPIC_API_KEY` to
ever be exercised, so it was left out of this pass rather than written-but-unverified.
`providers/types.ts`'s `LlmProvider`/`ProviderDelta`/`TurnContext` shapes are already
modeled after Anthropic's streaming/tool-use API for exactly this reason, and
`providers/factory.ts`'s `getProvider()` — the composition root — already returns a
`ProviderRouter`, so adding a second provider later is
`new ProviderRouter([new AnthropicProvider(), new MockProvider()])` with **no other
code change** anywhere: not the router, not the circuit breaker, not
`agent/orchestrator.ts`. `LLM_PROVIDER=anthropic` currently throws a clear error
rather than silently degrading to the mock. Before writing it: consult the
`claude-api` skill for current model ids (default should be `claude-opus-4-8`), the
exact tool-definition JSON shape, and streaming event names.

## Smaller, explicitly-scoped simplifications from this pass

- **Circuit breaker failover is connect-time / first-delta only.** If a provider
  throws *after* already yielding some deltas (a genuine mid-stream failure), those
  deltas are not retracted — the next provider's turn starts fresh, which can look
  like "the answer cut off, then restarted" rather than a clean handoff. Acceptable
  and documented in `providers/router.ts`; revisit once `AnthropicProvider` makes
  mid-stream failures a real (not just theoretical) case.
- **Archived versions are not filtered from any read endpoint or exposed in any
  DTO.** `workflow_version.archivedAt` (set by `workers/archival-worker.ts` for
  versions older than `ARCHIVE_AFTER_DAYS`, default 90) is a backend-only lifecycle
  annotation this pass — `GET /api/workflows/:id/versions` etc. are byte-identical
  to before. An opt-in `?includeArchived=` filter is a documented future option, not
  built now (see `routes/workflows.ts` and `schema.prisma`'s `WorkflowVersion` doc).
- **`seq` assignment is Redis-atomic but single-Redis.** `redis/seq.ts`'s Lua
  script is race-free across any number of backend API processes, but assumes one
  Redis instance (no Cluster/Sentinel). Fine at this scale; would need
  cluster-aware key hashing to shard across multiple Redis nodes.
- **The embedding dimension (256) is fixed at migration time**, not
  env-configurable — `embeddings/embedder.ts`'s `EMBEDDING_DIM` constant is the
  single source of truth; changing it needs a new migration. Deliberate: the
  `MockEmbedder` it backs is a deterministic, zero-cost stand-in (Anthropic has no
  embeddings endpoint), not a real model whose dimension is a hard external
  constraint.
- **The validation worker's catalog-integrity sweep is read-only by design** — it
  reports what it finds via `job.lastError`, it never repairs anything
  automatically. A workflow a catalog change silently broke stays broken until a
  human edits it through the normal chat flow (which re-validates and re-proposes).
- **No webhook-driven runs.** `POST /api/dev/simulate/stripe-payment` acknowledges
  receipt only; nothing currently turns a simulated Stripe event into an actual run
  against a workflow. Would need a route that looks up workflows with a matching
  trigger type and starts a run for each.
- **`Docker prune` gotchas already worked through, worth knowing if editing the
  Dockerfiles:** `turbo prune --docker` only understands the package.json
  dependency graph, not relative `tsconfig`/`eslintrc` `extends` paths — both
  Dockerfiles explicitly `COPY --from=pruner /app/tsconfig.base.json` (and
  `.eslintrc.base.json` for the frontend) back in after pruning. The repo's pinned
  `packageManager` (`pnpm@11.9.0`) needs Node ≥22.13 even though `engines.node` says
  `>=20.0.0` — both Dockerfiles use `node:22-slim`, not `node:20-slim`, for exactly
  this reason (worth reconciling the `engines` field itself at some point).
  `apps/backend/package.json`'s `postinstall` is guarded
  (`test -f prisma/schema.prisma && prisma generate || true`) because it fires
  during the pruned partial-install stage, before the schema file exists there.

## Known simplifications carried over from the previous pass (still true)

- `workflow.ownerId` is hardcoded to a fixed `"dev-user"` string — there is no
  authentication/authorization layer.
- `MockProvider`'s scenario selection is keyword-based, not semantic intent
  classification — grounded in the real catalog via `search_nodes` (now genuinely
  pgvector-backed) before deciding what to propose, but the initial routing
  decision is still a regex match on the user's message.
- The real backend and `apps/frontend/mock/` remain two independent
  implementations of the same contract (by design). The mock was **not** updated
  with any of this pass's backend-only infrastructure (Redis, BullMQ, pgvector,
  circuit breaker) since none of it changes the contract surface the mock needs to
  match — only `apps/backend`'s internals changed.
- No approval **history/audit view** beyond a version's own `changeSummary` — "who
  approved this and when" isn't a first-class record.
