# Multi-stage build for @zoft/backend, using Turborepo's own `turbo prune`
# (this monorepo already runs on Turborepo — see root turbo.json) to pull
# just @zoft/backend and its one internal dependency, @zoft/contract, out of
# the workspace into a minimal, correctly-lockfiled subset. This is the
# standard Turborepo Docker pattern, not a bespoke one — see
# https://turbo.build/repo/docs/guides/tools/docker.
#
# Build from the MONOREPO ROOT, not this directory:
#   docker build -f apps/backend/Dockerfile -t zoft-backend .
# (infra/docker-compose.yml's `backend` service does exactly this.)
#
# Runs `prisma migrate deploy && prisma db seed` on container start
# (docker-entrypoint.sh) — both are idempotent (deploy only applies pending
# migrations; seed is an upsert keyed on `type`, see prisma/seed.ts), so
# restarting the container never re-applies or duplicates anything.

# node:22-slim, not 20 — the repo's pinned packageManager (pnpm@11.9.0,
# root package.json) requires Node >=22.13 even though engines.node says
# ">=20.0.0"; that field predates this pnpm version. Node 22 is also still
# >=20, so this doesn't contradict the stated engines range.
FROM node:22-slim AS base
# Prisma's engine needs to detect the container's OpenSSL version to fetch
# the matching binary; node:22-slim doesn't have it installed by default,
# which makes Prisma guess (and warn) instead. Installing it explicitly is
# exactly what Prisma's own warning recommends.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---- 1. Prune the workspace down to @zoft/backend + @zoft/contract ----
FROM base AS pruner
COPY . .
RUN npx turbo prune @zoft/backend --docker

# ---- 2. Install pruned deps (cacheable — only invalidated by dependency changes) ----
FROM base AS installer
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ---- 3. Bring in full pruned source, build contract then backend ----
FROM installer AS builder
COPY --from=pruner /app/out/full/ .
# turbo prune only understands the package.json dependency graph, not
# relative `extends` paths — tsconfig.base.json isn't part of any package's
# own file tree, so it has to be copied in explicitly (from the pruner
# stage, which still has the untouched original repo) or every package's
# `tsc` build fails to resolve its base config.
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
RUN pnpm --filter @zoft/contract build
RUN pnpm --filter @zoft/backend exec prisma generate
RUN pnpm --filter @zoft/backend build

# ---- 4. Runtime ----
FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app .
WORKDIR /app/apps/backend
COPY apps/backend/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
EXPOSE 3001
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
