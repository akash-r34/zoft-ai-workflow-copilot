import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "../embedder.js";
import { MockEmbedder } from "../mock-embedder.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // both inputs are already L2-normalized, so dot product == cosine similarity
}

describe("MockEmbedder", () => {
  const embedder = new MockEmbedder();

  it("produces a vector of the declared dimension", () => {
    expect(embedder.dim).toBe(EMBEDDING_DIM);
    expect(embedder.embed("stripe payment received")).toHaveLength(EMBEDDING_DIM);
  });

  it("is deterministic — the same text always embeds to the same vector", () => {
    const a = embedder.embed("Slack: Send Message");
    const b = embedder.embed("Slack: Send Message");
    expect(a).toEqual(b);
  });

  it("is case-insensitive and tokenizes on non-alphanumeric characters", () => {
    const a = embedder.embed("Slack: Send Message");
    const b = embedder.embed("slack send message");
    expect(a).toEqual(b);
  });

  it("L2-normalizes: the vector's own magnitude is 1 (or 0 for empty input)", () => {
    const v = embedder.embed("send a slack message when stripe receives a payment");
    const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it("handles text with no tokens (empty/whitespace/punctuation-only) without dividing by zero", () => {
    const v = embedder.embed("   ...   ");
    expect(v).toHaveLength(EMBEDDING_DIM);
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it("rewards shared vocabulary: overlapping text is more similar than unrelated text", () => {
    const base = embedder.embed("Stripe: Payment Received — fires when Stripe receives a payment");
    const related = embedder.embed("Stripe payment received trigger");
    const unrelated = embedder.embed("Schedule: Weekday Filter allowed days");

    expect(cosine(base, related)).toBeGreaterThan(cosine(base, unrelated));
  });
});
