// The LLM provider abstraction. Modeled loosely on the Anthropic Messages API's
// streaming/tool-use shape (see the `claude-api` skill) so a future
// AnthropicProvider is a drop-in second implementation of the same interface
// — swapping providers is a config change (LLM_PROVIDER env var), never a
// call-site change in agent/orchestrator.ts. Only MockProvider (see
// mock-provider.ts) exists today; AnthropicProvider is documented as
// remaining work in REMAINING.md.
import type { NodeDefinitionDto, ValidationError, WorkflowGraph } from "@zoft/contract";

export type ProviderDelta =
  | { type: "text"; text: string }
  | { type: "tool_use"; callId: string; tool: string; input: unknown }
  | { type: "finish"; reason: "end_turn" | "tool_use" | "stop" }
  // Simulates a ProviderRouter failing over from an unavailable primary to a
  // fallback provider (reliability failure mode #7). A real router + circuit
  // breaker sitting in front of a swappable provider list is documented as
  // remaining work (REMAINING.md) — MockProvider emits this delta directly
  // for the "mentions 'provider'" demo scenario so the failover UX
  // (provider.switched SSE event) is still exercised end-to-end.
  | { type: "provider_switch"; from: string; to: string; reason: string };

/**
 * Everything the provider needs to produce one turn's deltas. `attempt` and
 * `priorErrors` let the orchestrator re-invoke the provider after a failed
 * validation (self-correction) — the provider sees what went wrong last time
 * and can adjust, exactly as a real tool-use conversation would replay the
 * tool_result content back to the model.
 */
export interface TurnContext {
  userMessage: string;
  currentGraph: WorkflowGraph;
  /** Full node definitions (not just the validator's CatalogEntry projection) so a provider can render display names and reason about categories. */
  catalog: NodeDefinitionDto[];
  attempt: number;
  priorErrors?: ValidationError[];
  /** Populated from the workflow's current version row, for richer "explain"/"why" answers. Undefined when the workflow has no version yet. */
  lastChangeSummary?: string;
  isFirstVersion?: boolean;
}

export interface LlmProvider {
  readonly name: string;
  run(ctx: TurnContext): AsyncIterable<ProviderDelta>;
}

/** Thrown by a provider's run() to signal it is unavailable — trips the ProviderRouter's circuit breaker (see router.ts). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerName: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
