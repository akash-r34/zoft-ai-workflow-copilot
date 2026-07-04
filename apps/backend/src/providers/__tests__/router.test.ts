import { describe, expect, it } from "vitest";
import { ProviderRouter } from "../router.js";
import { ProviderError } from "../types.js";
import type { LlmProvider, ProviderDelta, TurnContext } from "../types.js";

const CTX: TurnContext = {
  userMessage: "hi",
  currentGraph: { nodes: [], edges: [] },
  catalog: [],
  attempt: 1,
};

/** Always throws before yielding anything — simulates a provider that's unreachable (rate-limited, outage, etc.). Test-only; the router itself has no awareness of this vs. any other LlmProvider. */
class FailingProvider implements LlmProvider {
  constructor(readonly name: string) {}
  // eslint-disable-next-line @typescript-eslint/require-await, require-yield -- must match the async-generator LlmProvider signature (only a real AsyncGenerator satisfies AsyncIterable); this fake throws before any await or yield would matter
  async *run(): AsyncIterable<ProviderDelta> {
    throw new ProviderError(`${this.name} is unavailable`, this.name);
  }
}

class WorkingProvider implements LlmProvider {
  constructor(
    readonly name: string,
    private readonly deltas: ProviderDelta[] = [{ type: "text", text: "ok" }, { type: "finish", reason: "end_turn" }],
  ) {}
  // eslint-disable-next-line @typescript-eslint/require-await -- must match the async-generator LlmProvider signature; this fake's deltas are already in hand, no real await needed
  async *run(): AsyncIterable<ProviderDelta> {
    for (const delta of this.deltas) yield delta;
  }
}

async function collect(iter: AsyncIterable<ProviderDelta>): Promise<ProviderDelta[]> {
  const out: ProviderDelta[] = [];
  for await (const d of iter) out.push(d);
  return out;
}

describe("ProviderRouter", () => {
  it("passes through a single working provider's deltas unchanged", async () => {
    const router = new ProviderRouter([new WorkingProvider("solo")]);
    const deltas = await collect(router.run(CTX));
    expect(deltas).toEqual([{ type: "text", text: "ok" }, { type: "finish", reason: "end_turn" }]);
  });

  it("fails over to the next provider, emitting a provider_switch delta first", async () => {
    const router = new ProviderRouter([new FailingProvider("primary"), new WorkingProvider("fallback")]);
    const deltas = await collect(router.run(CTX));
    expect(deltas[0]).toEqual({
      type: "provider_switch",
      from: "primary",
      to: "fallback",
      reason: "primary is unavailable",
    });
    expect(deltas.slice(1)).toEqual([{ type: "text", text: "ok" }, { type: "finish", reason: "end_turn" }]);
  });

  it("throws when every provider is unavailable", async () => {
    const router = new ProviderRouter([new FailingProvider("a"), new FailingProvider("b")]);
    await expect(collect(router.run(CTX))).rejects.toThrow(/b is unavailable/);
  });

  it("does not retry a provider whose breaker has tripped open across calls", async () => {
    const primary = new FailingProvider("primary");
    const fallback = new WorkingProvider("fallback");
    // Threshold 1 via env default in tests is 3 — construct with an explicit
    // low-threshold breaker by tripping it across three separate run() calls
    // (the default PROVIDER_FAILURE_THRESHOLD), then assert the fourth call
    // skips straight to the fallback with no provider_switch delta (nothing
    // to "switch" — primary was never attempted).
    const router = new ProviderRouter([primary, fallback]);
    for (let i = 0; i < 3; i++) {
      await collect(router.run(CTX)); // trips the breaker toward open (default threshold 3)
    }
    const deltas = await collect(router.run(CTX));
    // Once open, canAttempt() is false for `primary`, so the loop skips it
    // entirely and goes straight to `fallback` — no provider_switch delta,
    // since nothing was attempted-then-failed on this call.
    expect(deltas).toEqual([{ type: "text", text: "ok" }, { type: "finish", reason: "end_turn" }]);
  });

  it("throws a generic ProviderError if constructed with an empty provider list", () => {
    expect(() => new ProviderRouter([])).toThrow(/at least one provider/);
  });
});
