// pgvector-backed semantic search over the node catalog — the "R" in RAG.
// search_nodes (tools/read-tools.ts) tries this first and falls back to the
// existing keyword search (catalog-service.ts's searchCatalog) if it errors
// or comes back empty (e.g. before the embedding backfill worker has run, or
// for a catalog row nothing has embedded yet).
import type { PrismaClient } from "@prisma/client";
import type { Embedder } from "../embeddings/embedder.js";
import { toVectorLiteral } from "../embeddings/serialize.js";

export async function searchNodesByVector(
  prisma: PrismaClient,
  embedder: Embedder,
  query: string,
  k: number,
): Promise<string[]> {
  try {
    const literal = toVectorLiteral(embedder.embed(query));
    // `<=>` is pgvector's cosine-distance operator (smaller = more similar).
    // No ANN index (ivfflat/hnsw) at this catalog size — an exact scan over
    // a handful of rows is both correct and fast; add one once row count
    // warrants it.
    const rows = await prisma.$queryRaw<{ type: string }[]>`
      SELECT type FROM node_definition
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${k}
    `;
    return rows.map((r) => r.type);
  } catch {
    return [];
  }
}
