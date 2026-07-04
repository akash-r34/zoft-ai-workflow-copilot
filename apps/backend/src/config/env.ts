// Centralized, validated environment configuration. Every other module reads
// runtime config through `env`, not `process.env` directly, so a missing or
// malformed var fails fast at boot instead of surfacing as a confusing bug
// three layers deep in the agent loop.
//
// Side-effect-only import: per CLAUDE.md, "@prisma/client auto-loads
// apps/backend/.env as an import side effect." This module is normally one
// of the FIRST things index.ts pulls in transitively (via app.ts), which
// would otherwise validate process.env before anything has triggered that
// side effect. Importing @prisma/client here — before EnvSchema is parsed —
// guarantees .env is loaded regardless of where else in the graph
// db/prisma.ts happens to sit.
import "@prisma/client";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  LLM_PROVIDER: z.enum(["mock", "anthropic"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),
  // Max repair attempts after the first proposal fails validation. PRD v1.1
  // Decision #2 sets the default to 1 (down from the earlier plan's "start
  // with 3") — configurable so a demo can widen the window back up, e.g.
  // `SELF_CORRECTION_BUDGET=3 pnpm --filter @zoft/backend dev`.
  SELF_CORRECTION_BUDGET: z.coerce.number().int().min(0).default(1),
  // Wall-clock budget for a single run before it is forced into `run.timeout`.
  // Kept short by default so the timeout demo scenario (see mock-provider.ts)
  // resolves quickly instead of making a reviewer wait.
  RUN_DEADLINE_MS: z.coerce.number().int().positive().default(6000),
  // PRD v1.1 Decision #1: a human approval step between validation and the
  // version applier is mandatory. Defaulting true matches the Final PRD;
  // false is a legacy/test escape hatch that auto-commits like the original
  // (pre-v1.1) mock did, useful for integration tests that don't want to
  // simulate the extra HTTP round trip.
  APPROVAL_REQUIRED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console -- boot-time fatal config error, not a src/ runtime path
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}

export const env: Env = loadEnv();
