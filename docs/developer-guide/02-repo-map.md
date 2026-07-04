# 02 — Repo Map and Conventions

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

## The monorepo, top to bottom

```
zoft-copilot/
  apps/
    backend/        Fastify API + AI orchestration + BullMQ workers (Node.js, ESM)
    frontend/       Chat UI + workflow viz (Next.js 14 App Router)
      mock/         An independent second implementation of the same contract — see 11-mock-backend.md
  packages/
    contract/       Shared types, Zod schemas, the SSE event union — see 05-contract-package.md
  infra/
    docker-compose.yml   Full local stack — see 14-ops-and-docker.md
    init-db.sql          CREATE EXTENSION IF NOT EXISTS vector
  docs/
    architecture.md       Outside-reader system design doc
    api.md                REST + SSE endpoint reference
    demo.webm             Recorded Playwright walkthrough
    developer-guide/       This guide
  .github/workflows/ci.yml
  Plans/                  Original design documents (do not edit)
  REMAINING.md            What's deliberately deferred, and why
  CLAUDE.md               The project's own AI-assistant instructions — also a good terse summary for a human
```

## pnpm workspaces + Turborepo

`pnpm-workspace.yaml:1-3` declares `apps/*` and `packages/*` as workspace packages.
`turbo.json` defines four cacheable tasks — `build`, `lint`, `typecheck`, `test` — each
`dependsOn: ["^build"]` (`turbo.json:4-21`), meaning a package's dependencies get built
first. This is why `pnpm --filter @zoft/contract build` has to run before anything else
touches the backend or frontend: both declare `"@zoft/contract": "workspace:*"` in their
`package.json` dependencies, and neither can type-check or build without the contract
package's compiled `.d.ts` output existing first.

`turbo run dev --parallel` (root `pnpm dev`) runs every package's own `dev` script
concurrently — see `14-ops-and-docker.md`'s note on why this collides with the frontend's
bundled mock server and what to run instead when you want the frontend against the real
backend.

## The one hard rule: `packages/contract` is the only shared-type boundary

> **Never define a shared type outside `packages/contract`.** Both apps import from
> `@zoft/contract`; neither redefines what already lives there.

This isn't a style preference — it's what keeps the backend and frontend, two separately
compiled TypeScript programs that never see each other's source, from silently drifting
apart on what a `WorkflowGraph` or an `SseEvent` even *is*. `05-contract-package.md` is the
full chapter on this package; if you're about to write an interface that both apps need,
that's where it belongs, not duplicated in each app's own `types.ts`.

## TypeScript conventions (`tsconfig.base.json`)

Every package's `tsconfig.json` extends the root `tsconfig.base.json`:

```json
// tsconfig.base.json (full file)
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

The three settings most likely to surprise you coming from a looser TS config:

- **`moduleResolution: "NodeNext"`** — every local import needs an explicit `.js`
  extension, even though the source file is `.ts` (e.g.
  `import { foo } from "./bar.js"` in `bar.ts`). This trips up nearly everyone the first
  time; it's required by Node's own native ESM resolution, which `NodeNext` mirrors exactly.
- **`noUncheckedIndexedAccess: true`** — `array[i]` has type `T | undefined`, not `T`. You'll
  see `if (existing === undefined) return graph;`-style guards throughout `core/applier.ts`
  (`06-deterministic-core.md`) specifically because of this setting — it's not defensive
  paranoia, the compiler requires it.
- **`exactOptionalPropertyTypes: true`** — `{ foo?: string }` means "the key is either absent
  or a `string`," never "the key is present with value `undefined`." This is why you'll see
  spread patterns like `...(value !== undefined ? { key: value } : {})` throughout the
  codebase (e.g. `agent/orchestrator.ts`'s `TurnContext` construction) instead of
  `{ key: value }` where `value` might be `undefined`.

Package-local overrides (e.g. `esModuleInterop` where a CJS dependency needs it) are normal
— they extend the root config, never fork it wholesale.

## Lint and format

`.eslintrc.base.json` (root) is what every package's own `.eslintrc.json` extends:

```json
// .eslintrc.base.json (full file)
{
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended", "plugin:@typescript-eslint/recommended-requiring-type-checking"],
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
    "no-console": ["warn", { "allow": ["warn", "error"] }]
  }
}
```

Notable rules: **no `any`** is a hard error (you'll see `unknown` + a narrowing check
everywhere a boundary type is genuinely unknown, e.g. `ToolResult`'s `result: unknown` in
`tools/types.ts`); a leading underscore (`_foo`) marks an intentionally-unused
variable/argument and is exempted from the unused-vars check; and plain `console.log` warns
— only `console.warn`/`console.error` are allowed (used sparingly, e.g.
`workers/main.ts`'s boot-status line, `core/env.ts`'s fatal-config-error path).

The frontend additionally extends `next/core-web-vitals`, pinned to
`eslint-config-next@14.2.0` to match its Next.js 14 + ESLint 8 versions exactly
(`apps/frontend/package.json`).

Prettier: double quotes, semicolons, trailing commas, 100-char print width. Format checking
is part of CI; run `pnpm exec prettier --write .` to reformat everything.

## Quick "where do I start reading" table

| I want to understand... | Start here |
|---|---|
| The one rule that governs every design decision | `03-the-core-invariant.md` |
| The database schema | `04-data-model.md`, `apps/backend/prisma/schema.prisma` |
| Shared types both apps use | `05-contract-package.md`, `packages/contract/src/` |
| How a graph edit is validated/applied | `06-deterministic-core.md`, `apps/backend/src/core/` |
| How the AI agent loop works | `07-agent-and-providers.md`, `apps/backend/src/agent/orchestrator.ts` |
| REST routes + real-time SSE delivery | `08-api-and-runs.md`, `apps/backend/src/routes/`, `apps/backend/src/runs/` |
| Background jobs (embeddings, validation sweep, archival) | `09-workers.md`, `apps/backend/src/workers/` |
| The chat UI, state management, graph visualization | `10-frontend.md`, `apps/frontend/src/` |
| The standalone dev-only backend | `11-mock-backend.md`, `apps/frontend/mock/` |
| "Show me one whole request, start to finish" | `12-end-to-end-trace.md` |
| How to run the test suite | `13-testing.md` |
| Docker, env vars, deployment | `14-ops-and-docker.md` |
| "I want to add X" | `15-extending.md` |

## CI (`.github/workflows/ci.yml`)

```yaml
# .github/workflows/ci.yml:26-39
- run: pnpm install --frozen-lockfile
- run: pnpm --filter @zoft/contract build
- run: pnpm -r typecheck
- run: pnpm -r lint
- run: pnpm test
```

On push to `main`/`develop` and PRs into `main` (`ci.yml:3-7`). All five steps (install
included) must be green before merging. No `DATABASE_URL`/`REDIS_URL` is set in CI, so the
gated integration test tiers always skip there (`13-testing.md`).

---
**Prev:** [`01-getting-started.md`](./01-getting-started.md) · **Next:**
[`03-the-core-invariant.md`](./03-the-core-invariant.md) · **Related:**
[`05-contract-package.md`](./05-contract-package.md)
