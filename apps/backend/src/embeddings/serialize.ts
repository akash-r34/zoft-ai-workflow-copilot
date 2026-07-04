// Converts a JS number[] embedding into pgvector's text literal format
// ("[0.12,0.34,...]") for binding into a raw SQL ::vector cast
// (catalog/vector-search.ts, workers/embedding-worker.ts). No pgvector npm
// package needed at this scale — this one function is the entire
// serialization surface.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
