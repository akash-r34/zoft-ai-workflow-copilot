import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { applyVersion, restoreVersion } from "../version-applier.js";
import type { CatalogEntry, Operation } from "../types.js";

// Real-database integration test — exercises applyVersion end-to-end against
// actual Postgres via Prisma, as a check that the in-memory fake used in
// version-applier.test.ts stays faithful to the real client's behavior.
//
// Gated on a dedicated opt-in flag (RUN_DB_INTEGRATION_TESTS), NOT merely on
// DATABASE_URL being set: importing "@prisma/client" auto-loads
// apps/backend/.env as a side effect, so DATABASE_URL is already populated
// for any developer who has followed the normal onboarding step of copying
// .env.example to .env — whether or not Postgres is actually running. Gating
// on that alone would make `pnpm test` silently attempt a live DB connection
// (and fail/hang) for anyone with a plain .env and no Docker running. CI has
// neither var, so this suite always skips there. To run it locally against
// the Docker Postgres from infra/docker-compose.yml:
//
//   docker compose -f infra/docker-compose.yml up -d
//   RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @zoft/backend test -- version-applier.integration
const RUN_DB_INTEGRATION_TESTS = process.env["RUN_DB_INTEGRATION_TESTS"];

describe.skipIf(!RUN_DB_INTEGRATION_TESTS)("applyVersion (integration)", () => {
  const prisma = new PrismaClient();
  let workflowId: string;

  const CATALOG: CatalogEntry[] = [
    {
      type: "stripe.payment_received",
      category: "trigger",
      configSchema: { type: "object", properties: {}, additionalProperties: false },
      inputs: [],
      outputs: [{ name: "payment", type: "stripe.Payment" }],
    },
  ];

  beforeAll(async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "phase1-integration-test", ownerId: "test-owner" },
    });
    workflowId = workflow.id;
  });

  afterAll(async () => {
    // Null the FK pointer before deleting versions, then the workflow, to
    // avoid violating the workflow <-> workflow_version cross-reference.
    await prisma.workflow.update({ where: { id: workflowId }, data: { currentVersionId: null } });
    await prisma.workflowVersion.deleteMany({ where: { workflowId } });
    await prisma.workflow.delete({ where: { id: workflowId } });
    await prisma.$disconnect();
  });

  it("inserts exactly one workflow_version row and updates the workflow pointer on success", async () => {
    const ops: Operation[] = [
      {
        op: "add_node",
        node: { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
      },
    ];

    const before = await prisma.workflowVersion.count({ where: { workflowId } });
    const result = await applyVersion(
      prisma,
      workflowId,
      ops,
      CATALOG,
      "ai",
      "integration test: add trigger",
    );
    const after = await prisma.workflowVersion.count({ where: { workflowId } });

    expect("error" in result).toBe(false);
    expect(after - before).toBe(1);

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentVersionId).not.toBeNull();
  });

  it("writes zero rows when the candidate graph fails validation", async () => {
    const invalidOps: Operation[] = [
      {
        op: "add_node",
        node: { id: "unknown1", type: "totally.unknown", config: {}, position: { x: 0, y: 0 } },
      },
    ];

    const before = await prisma.workflowVersion.count({ where: { workflowId } });
    const result = await applyVersion(
      prisma,
      workflowId,
      invalidOps,
      CATALOG,
      "ai",
      "integration test: invalid",
    );
    const after = await prisma.workflowVersion.count({ where: { workflowId } });

    expect("error" in result).toBe(true);
    expect(after).toBe(before);
  });

  it("restoreVersion re-saves an earlier version as a new one against the real DB", async () => {
    // At this point workflowId has version 1 (from the first test above) —
    // restoring version 1 onto itself should still create version 2.
    const before = await prisma.workflowVersion.count({ where: { workflowId } });
    const result = await restoreVersion(prisma, workflowId, 1, CATALOG);
    const after = await prisma.workflowVersion.count({ where: { workflowId } });

    expect("error" in result).toBe(false);
    expect(after - before).toBe(1);
    if (!("error" in result)) {
      const created = await prisma.workflowVersion.findUniqueOrThrow({
        where: { workflowId_version: { workflowId, version: result.version } },
      });
      expect(created.changeSummary).toBe("Restored to version 1");
      expect(created.createdBy).toBe("user");
    }
  });
});
