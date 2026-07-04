// The embedding abstraction — mirrors providers/types.ts's LlmProvider
// pattern: a small interface MockEmbedder implements today, so a real
// embedding provider (there is currently none configured — Anthropic has no
// embeddings endpoint) is a drop-in second implementation later. EMBEDDING_DIM
// is the single shared constant the migration and every embedder must agree
// on; it is NOT env-configurable (changing it needs a new migration).
export const EMBEDDING_DIM = 256;

export interface Embedder {
  readonly dim: number;
  embed(text: string): number[];
}
