// Resolves the configured LlmProvider. Only MockProvider exists today —
// LLM_PROVIDER=anthropic fails fast with a clear message rather than
// silently degrading to the mock, since wiring a real @anthropic-ai/sdk
// client is out of scope for this pass (see REMAINING.md).
import { env } from "../config/env.js";
import { MockProvider } from "./mock-provider.js";
import type { LlmProvider } from "./types.js";

let cached: LlmProvider | undefined;

export function getProvider(): LlmProvider {
  if (cached) return cached;
  if (env.LLM_PROVIDER === "anthropic") {
    throw new Error(
      "LLM_PROVIDER=anthropic is not implemented yet — see REMAINING.md for the AnthropicProvider design. Set LLM_PROVIDER=mock (the default) to run the Copilot with the deterministic provider.",
    );
  }
  cached = new MockProvider();
  return cached;
}
