#!/bin/sh
# Runs before both the `backend` (node dist/index.js) and `worker`
# (node dist/workers/main.js) compose services — both use this same image
# and entrypoint (infra/docker-compose.yml). Safe to run from both
# containers on simultaneous startup: `prisma migrate deploy` only applies
# pending migrations (a no-op once applied) and takes its own advisory lock
# for concurrent-deploy safety; `prisma db seed` is an idempotent upsert
# keyed on node type (prisma/seed.ts).
set -e

npx prisma migrate deploy
npx prisma db seed

exec "$@"
