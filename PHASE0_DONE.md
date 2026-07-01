# Phase 0 Complete

## Decisions not prescribed in the prompt

### Package manager
- **pnpm** was not installed on the machine. Installed globally via `npm install -g pnpm`.
  Installed version: **pnpm 11.9.0** (exceeds the `>=9.0.0` engine requirement).

### Turborepo `packageManager` field
- Turborepo 2.10 (installed as `latest`) requires a `packageManager` field in the root
  `package.json`. Added `"packageManager": "pnpm@11.9.0"`.

### esbuild build-script approval
- pnpm 11 blocks all post-install scripts by default for security. `esbuild` (required
  by `vitest` and `tsx`) needed approval. Ran `pnpm approve-builds --all`. The
  `onlyBuiltDependencies: [esbuild]` entry is now recorded in `pnpm-workspace.yaml` and
  the lockfile.

### ESLint per-package configs
- ESLint 8 does not find configs via inheritance from the root. Each package received its
  own `.eslintrc.json` extending `../../.eslintrc.base.json`. The frontend also extends
  `next/core-web-vitals` (with `eslint-config-next` pinned to `14.2.0` to match Next.js
  14 and ESLint 8 — the latest `eslint-config-next` v16 targets ESLint 9 flat config
  and is incompatible).

### `varsIgnorePattern` in ESLint base
- The base ESLint rule for `no-unused-vars` only ignored function arguments (`argsIgnorePattern`)
  but not variables/type aliases. Added `"varsIgnorePattern": "^_"` to support the
  `_`-prefixed type alias pattern used in the acceptance criterion imports.

### `@types/node` for backend
- Node.js globals (`process`, etc.) are not in scope with the base `tsconfig.base.json`
  (`"lib": ["ES2022"]` only). Added `@types/node@^20.0.0` to backend devDependencies
  and `"types": ["node"]` to `apps/backend/tsconfig.json`.

### Frontend placeholder test
- The handover only specifies a placeholder test for the backend. `vitest run` exits 1
  when no test files are found, which would fail `pnpm test`. Added an identical
  placeholder test at `apps/frontend/src/__tests__/placeholder.test.ts`.

### `src/app/globals.css`
- Not specified in the handover but required for `next build` to succeed with Tailwind.
  Added with the standard `@tailwind base/components/utilities` directives, imported
  from `layout.tsx`.

### Next.js tsconfig modifications
- `next build` automatically added `allowJs`, `noEmit`, `esModuleInterop`,
  `resolveJsonModule`, `isolatedModules` to `apps/frontend/tsconfig.json`.
  These are required by the Next.js compiler and are not overrideable from outside.

### Turbo output warnings
- `WARNING no output files found for task @zoft/frontend#test / @zoft/backend#test`.
  This is benign: test tasks only produce `coverage/**` when the `--coverage` flag is
  used. Phase 1 adds real tests and a coverage step; the warning disappears then.

### Skills install location
- `npx skills add` (without `-g`) installs to `.agents/skills/` in the workspace root
  with a symlink to `~/.claude/`. This satisfies the "local to workspace" requirement.

### Docker (deferred)
- Docker Desktop is not installed on this machine. The infra files are fully in place
  (`infra/docker-compose.yml`, `infra/init-db.sql`). The live verification step must
  be run after Docker Desktop is installed:
  ```bash
  docker compose -f infra/docker-compose.yml up -d
  sleep 5
  docker compose -f infra/docker-compose.yml exec postgres \
    psql -U postgres -d zoft -c "SELECT 1 FROM pg_extension WHERE extname = 'vector';"
  docker compose -f infra/docker-compose.yml down
  ```
  Expected: one row returned.

---

## Verification output

```
=== pnpm install ===
Done in 307ms using pnpm v11.9.0

=== pnpm --filter @zoft/contract build ===
$ tsc --project tsconfig.json
(exits 0 — no output means no errors)

=== pnpm -r build ===
packages/contract build: Done
apps/backend build: Done
apps/frontend build: Done  (Next.js 14, 4 static pages)

=== pnpm -r typecheck ===
packages/contract typecheck: Done
apps/backend typecheck: Done
apps/frontend typecheck: Done

=== pnpm -r lint ===
packages/contract lint: Done
apps/backend lint: Done
apps/frontend lint: ✔ No ESLint warnings or errors  Done

=== pnpm test ===
@zoft/backend:test:   ✓ src/__tests__/placeholder.test.ts  (1 test)
@zoft/frontend:test:  ✓ src/__tests__/placeholder.test.ts  (1 test)
Tasks: 3 successful, 3 total
```

---

## Known issues / open questions for Phase 1

1. **Docker verification pending** — run the compose stack check once Docker Desktop is
   installed (see Deferred section above).

2. **Node v25.9.0** — the machine runs Node.js v25.9.0 (latest). The `engines` field
   requires `>=20.0.0`, so this is fine. Phase 1 should target the same version for
   `@types/node`. No issues observed in Phase 0.

3. **eslint-config-next pinned at 14.2.0** — matches Next.js 14. If Next.js is upgraded
   past 14 in a later phase, `eslint-config-next` should be upgraded alongside it.

4. **pnpm approve-builds** — esbuild is approved in the lockfile. If new packages with
   post-install scripts are added in Phase 1 (e.g., Prisma's `prisma generate`), run
   `pnpm approve-builds --all` after `pnpm install`.

5. **Turbo telemetry** — Turborepo 2.10 shows a one-time telemetry opt-in notice. It is
   opt-out only. If desired, run `turbo telemetry disable` to suppress the banner.
