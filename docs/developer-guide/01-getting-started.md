# 01 — Getting Started

> Anchored to commit `8df9601`. See `INDEX.md` for the full legend. For the full env-var
> reference and Docker internals, see `14-ops-and-docker.md` — this chapter is the fast
> path to a running app.

## Prerequisites

- **Node.js ≥ 22.13** (the repo's pinned `packageManager: pnpm@11.9.0` requires this, even
  though `package.json`'s `engines.node` still says `>=20.0.0` — see `14-ops-and-docker.md`
  for why that field is out of date).
- **pnpm** (`corepack enable` will pick up the pinned version automatically).
- **Docker Desktop**, for Postgres + Redis (or the full stack).

## The fastest path: full stack, zero setup

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

Wait for it to finish, then open **http://localhost:3000**. No `.env` file, no API key, no
manual seeding — Postgres (with pgvector), Redis, the real backend, the background worker,
and the production frontend build all come up together. Type a message and watch it work.

Tear down with `docker compose -f infra/docker-compose.yml down` (add `-v` to also drop the
Postgres data volume and start completely fresh next time).

## The development path: everything running locally, hot-reloading

```bash
pnpm install                                    # once, from the repo root
pnpm --filter @zoft/contract build              # the contract package — both apps depend on it
docker compose -f infra/docker-compose.yml up -d  # Postgres + Redis only
cp apps/backend/.env.example apps/backend/.env   # once
cp apps/frontend/.env.example apps/frontend/.env # once

pnpm --filter @zoft/backend db:migrate          # apply migrations (first time only)
pnpm --filter @zoft/backend db:seed             # seed the node catalog (idempotent, safe to re-run)

pnpm --filter @zoft/backend dev                 # terminal 1 — API on :3001
pnpm --filter @zoft/backend worker              # terminal 2 — background workers (embedding/validation/archival)
pnpm --filter @zoft/frontend exec next dev -p 3000   # terminal 3 — Next.js on :3000, talking to the REAL backend
```

Open **http://localhost:3000**.

**Do not substitute the last line with `pnpm --filter @zoft/frontend dev`** — that starts a
different thing: Next.js *and* the mock backend together (`11-mock-backend.md`), and the
mock defaults to the same port (`3001`) the real backend is already using. See
`14-ops-and-docker.md`'s troubleshooting table for the full explanation if you hit this.

## The frontend-only path: no backend, no database, no Redis

```bash
pnpm install
pnpm --filter @zoft/contract build
pnpm --filter @zoft/frontend dev     # Next.js on :3000 + the mock backend on :3001, together
```

This is genuinely the right command here — it's the one case where you *want* the bundled
mock. Useful for frontend-only work, or a demo where standing up Postgres/Redis isn't worth
it. See `11-mock-backend.md` for exactly what does and doesn't work identically to the real
backend under this path.

## Verifying it's working

1. Open http://localhost:3000 — a chat interface with an empty conversation should appear
   (one is auto-created on first load).
2. Type `send a Slack message whenever Stripe receives a payment` and press Enter.
3. Watch the activity timeline stream: "Planning workflow…" → "Searching available nodes…"
   → "Reading node schema…" → "Calling validator…"
4. A **"Review proposed change"** panel appears with a diff. Click **Approve**.
5. The right-hand panel shows the new graph (a Stripe trigger connected to a Slack action),
   briefly highlighted.

If step 4 never appears, check `APPROVAL_REQUIRED` (`apps/backend/.env`) is unset or
`true` — `false` auto-commits without ever showing the panel (a legacy/test escape hatch,
`14-ops-and-docker.md`'s env reference).

## Running the test suite

```bash
pnpm test                    # fast tier only — no Docker required
# to also run the DB/Redis-gated integration tests:
docker compose -f infra/docker-compose.yml up -d
RUN_DB_INTEGRATION_TESTS=1 RUN_REDIS_INTEGRATION_TESTS=1 pnpm test
```

See `13-testing.md` for exactly what each tier covers and why the gated tests need a
dedicated flag rather than just checking whether Postgres/Redis env vars are set.

## Static checks

```bash
pnpm -r typecheck   # tsc --noEmit across all packages
pnpm -r lint        # ESLint, zero errors required
pnpm -r build       # builds contract, backend, frontend
```

All three (plus `pnpm test`) are exactly what CI runs on every push/PR (`13-testing.md`).

## Where to go next

- New to the product, not just the code? You already read `00-orientation.md` — good.
- Want the "why is everything shaped this way" chapter? `03-the-core-invariant.md`.
- Want a guided tour of the repo's folders before diving into any one module?
  `02-repo-map.md`.
- Want to trace exactly what happens for the walkthrough above, file by file?
  `12-end-to-end-trace.md`.

---
**Prev:** [`00-orientation.md`](./00-orientation.md) · **Next:**
[`02-repo-map.md`](./02-repo-map.md) · **Related:**
[`14-ops-and-docker.md`](./14-ops-and-docker.md), [`13-testing.md`](./13-testing.md)
