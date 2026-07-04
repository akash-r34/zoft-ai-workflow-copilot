# Multi-stage build for @zoft/frontend, using the same `turbo prune` pattern
# as apps/backend/Dockerfile — see that file's header comment.
#
# Build from the MONOREPO ROOT, not this directory:
#   docker build -f apps/frontend/Dockerfile -t zoft-frontend .
#
# NEXT_PUBLIC_API_URL is a build-time value (Next.js inlines NEXT_PUBLIC_*
# vars into the client bundle at `next build`, not read at container
# runtime) — deliberately left unset here so apps/frontend/src/lib/api.ts's
# own fallback (`http://localhost:3001`) gets baked in. That's exactly
# right for this deployment shape: the browser runs on the HOST machine,
# not inside the Docker network, so it must reach the backend via its
# published host port (localhost:3001), not the internal service hostname.

# node:22-slim, not 20 — see apps/backend/Dockerfile's identical note: the
# repo's pinned packageManager (pnpm@11.9.0) requires Node >=22.13.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS pruner
COPY . .
RUN npx turbo prune @zoft/frontend --docker

FROM base AS installer
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM installer AS builder
COPY --from=pruner /app/out/full/ .
# turbo prune only understands the package.json dependency graph, not
# relative `extends` paths — tsconfig.base.json isn't part of any package's
# own file tree, so it has to be copied in explicitly (see
# apps/backend/Dockerfile's identical step) or every package's `tsc`/`next
# build` type-check fails to resolve its base config.
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
# next build also lints as part of the build — apps/frontend/.eslintrc.json
# extends this root config too.
COPY --from=pruner /app/.eslintrc.base.json ./.eslintrc.base.json
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @zoft/contract build
RUN pnpm --filter @zoft/frontend build

# ---- Runtime — Next.js standalone output (next.config.mjs's output: "standalone") ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=builder /app/apps/frontend/.next/standalone ./
COPY --from=builder /app/apps/frontend/.next/static ./apps/frontend/.next/static
EXPOSE 3000
CMD ["node", "apps/frontend/server.js"]
