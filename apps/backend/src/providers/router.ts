// ProviderRouter itself implements LlmProvider, so agent/orchestrator.ts's
// single `provider.run(ctx)` call site needs no changes at all — the router
// is a drop-in replacement for whatever single provider providers/factory.ts
// used to hand it directly. Wraps an ordered LlmProvider[], each with its
// own CircuitBreaker (circuit-breaker.ts). On a ProviderError from the
// currently-selected provider: marks its breaker failed, yields a
// provider_switch delta (the SAME shape MockProvider's own demo scenario
// already produces — see providers/types.ts — so agent/orchestrator.ts's
// existing provider.switched SSE path needs no changes either), and moves
// to the next available provider. Entirely generic: nothing here knows
// "mock" from "anthropic".
//
// Scoped limitation: if a provider throws after already yielding some
// deltas (a genuine mid-stream failure, as opposed to failing before its
// first delta), those already-yielded deltas are not retracted — the next
// provider's run() starts its own turn from scratch. A real deployment
// would see this as "the model's answer cut off, then restarted," an
// acceptable, visible failover artifact rather than silent duplication.
import { env } from "../config/env.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { ProviderError } from "./types.js";
import type { LlmProvider, ProviderDelta, TurnContext } from "./types.js";

export class ProviderRouter implements LlmProvider {
  readonly name = "router";
  private readonly breakers: CircuitBreaker[];

  constructor(private readonly providers: LlmProvider[]) {
    if (providers.length === 0) {
      throw new Error("ProviderRouter requires at least one provider");
    }
    this.breakers = providers.map(
      () => new CircuitBreaker(env.PROVIDER_FAILURE_THRESHOLD, env.PROVIDER_BREAKER_COOLDOWN_MS),
    );
  }

  async *run(ctx: TurnContext): AsyncIterable<ProviderDelta> {
    let lastError: unknown;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const breaker = this.breakers[i];
      if (!provider || !breaker || !breaker.canAttempt()) continue;

      try {
        for await (const delta of provider.run(ctx)) {
          yield delta;
        }
        breaker.onSuccess();
        return;
      } catch (err) {
        breaker.onFailure();
        lastError = err;
        const next = this.providers[i + 1];
        if (next) {
          yield {
            type: "provider_switch",
            from: provider.name,
            to: next.name,
            reason: err instanceof Error ? err.message : "provider unavailable",
          };
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ProviderError("all configured providers are unavailable", "router");
  }
}
