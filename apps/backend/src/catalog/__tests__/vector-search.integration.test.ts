// Real-database integration test for pgvector RAG (vector-search.ts's read
// path). Gated the same way as the other DB integration tests — see
// core/__tests__/version-applier.integration.test.ts's doc comment for why
// RUN_DB_INTEGRATION_TESTS, not DATABASE_URL, is the gate. Run:
//   docker compose -f infra/docker-compose.yml up -d
//   pnpm --filter @zoft/backend exec prisma migrate dev   (applies the embedding column)
//   RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @zoft/backend test -- vector-search
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { MockEmbedder } from "../../embeddings/mock-embedder.js";
import { toVectorLiteral } from "../../embeddings/serialize.js";
import { searchNodesByVector } from "../vector-search.js";

const RUN_DB_INTEGRATION_TESTS = process.env["RUN_DB_INTEGRATION_TESTS"];

describe.skipIf(!RUN_DB_INTEGRATION_TESTS)("searchNodesByVector (integration)", () => {
  const prisma = new PrismaClient();
  const embedder = new MockEmbedder();

  // Backfills every seeded catalog row's embedding directly (bypassing
  // BullMQ — this suite exercises the vector-search READ path; the write
  // path belongs to workers/embedding-worker.ts's own tests).
  async function backfillAll(): Promise<void> {
    const rows = await prisma.nodeDefinition.findMany();
    for (const row of rows) {
      const doc = `${row.displayName} ${row.description} ${row.provider} ${row.type}`;
      const literal = toVectorLiteral(embedder.embed(doc));
      await prisma.$executeRaw`
        UPDATE node_definition SET embedding = ${literal}::vector WHERE type = ${row.type}
      `;
    }
  }

  beforeAll(backfillAll);

  afterAll(async () => {
    await prisma.$executeRaw`UPDATE node_definition SET embedding = NULL`;
    await prisma.$disconnect();
  });

  it("returns the nearest node type first for a query matching its display name/description", async () => {
    const results = await searchNodesByVector(prisma, embedder, "Stripe payment received trigger", 3);
    expect(results[0]).toBe("stripe.payment_received");
  });

  it("returns a different top result for an unrelated query", async () => {
    const results = await searchNodesByVector(prisma, embedder, "Schedule weekday filter allowed days", 3);
    expect(results[0]).toBe("schedule.weekday_filter");
  });

  it("returns [] when nothing in the catalog has an embedding yet", async () => {
    await prisma.$executeRaw`UPDATE node_definition SET embedding = NULL`;
    const results = await searchNodesByVector(prisma, embedder, "anything", 3);
    expect(results).toEqual([]);
    await backfillAll(); // restore state for any test file run after this one
  });
});
