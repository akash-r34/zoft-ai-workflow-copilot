// Deterministic, dependency-free "embedding": feature-hashes each token of
// the input text into one of EMBEDDING_DIM buckets, accumulates a
// bag-of-words count vector, then L2-normalizes it. This is not semantically
// rich the way a trained model's embedding is, but it IS a genuine vector
// space where cosine similarity rewards shared vocabulary between two
// texts — enough to demonstrate the pgvector RAG path (catalog/vector-search.ts)
// end to end with zero API keys or external cost. See REMAINING.md.
import { EMBEDDING_DIM } from "./embedder.js";
import type { Embedder } from "./embedder.js";

function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export class MockEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;

  embed(text: string): number[] {
    const vector = new Array<number>(this.dim).fill(0);
    for (const token of tokenize(text)) {
      const bucket = fnv1a(token) % this.dim;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return vector;
    return vector.map((v) => v / norm);
  }
}
