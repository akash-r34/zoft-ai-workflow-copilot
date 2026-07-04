# 07 — The Agent Loop, Providers, and Tools

> Anchored to commit `8df9601`. Line numbers pair with a symbol name — if a line has
> drifted, grep the codebase for that name. See `INDEX.md` for the full legend.

This is the biggest chapter because it covers the biggest single file
(`agent/orchestrator.ts`, 359 lines) plus everything it depends on: the `LlmProvider`
abstraction, the only provider that exists (`MockProvider`), the reliability layer on top
of it (`ProviderRouter` + `CircuitBreaker`), the four tools the agent can call, and the RAG
search behind one of them. Read `03-the-core-invariant.md` first — this chapter is about
*how* the agent proposes, not why it's only ever allowed to propose.

## The shape of the problem

An AI chat turn isn't a single request/response — it's a loop: the model reasons, calls a
tool, sees the result, maybe calls another tool, maybe writes some text, and eventually
finishes. `agent/orchestrator.ts`'s `runOrchestrator` (`orchestrator.ts:74`) is the function
that drives this loop for one run, end to end, and — per PRD v1.1 Decision #1 — knows to
*pause* rather than finish when the loop produces a change that needs human sign-off.

```
agent/orchestrator.ts   the loop itself: budget, deadline, cancellation, the approval pause
providers/types.ts      LlmProvider interface + ProviderDelta + TurnContext + ProviderError
providers/mock-provider.ts   the only LlmProvider that exists — deterministic, scripted
providers/router.ts     ProviderRouter — wraps LlmProvider[], fails over on ProviderError
providers/circuit-breaker.ts   per-provider closed/open/half-open state machine
providers/factory.ts    getProvider() — the composition root orchestrator.ts calls
providers/graph-helpers.ts   makeNode/makeEdge — id-generation helpers MockProvider uses
tools/registry.ts        executeTool — dispatches a tool name to its handler
tools/read-tools.ts      search_nodes, get_node_schema, get_current_workflow (read-only)
tools/propose-operations.ts   propose_operations (validates, never writes)
tools/commit.ts          the ONLY caller of core/version-applier.ts (see ch. 03)
tools/types.ts           ToolContext / ToolResult shared shapes
catalog/vector-search.ts + embeddings/*   pgvector RAG behind search_nodes
```

## `LlmProvider` — the swappable interface

```ts
// apps/backend/src/providers/types.ts:41-55
export interface LlmProvider {
  readonly name: string;
  run(ctx: TurnContext): AsyncIterable<ProviderDelta>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly providerName: string) {
    super(message);
    this.name = "ProviderError";
  }
}
```

That's the entire interface: a name, and one method that returns an async stream of
`ProviderDelta`. It's modeled loosely on Anthropic's Messages API streaming/tool-use shape
(`types.ts:1-7`'s file comment) specifically so a future `AnthropicProvider` is a drop-in
second implementation — never a change to `agent/orchestrator.ts`'s call site. `ProviderError`
is the one exception type a provider can throw to signal "I am down" — that's what trips
the circuit breaker (`providers/router.ts`, below), as opposed to any other exception, which
propagates and fails the run outright.

### `ProviderDelta` — the four (five) things a provider can yield

```ts
// apps/backend/src/providers/types.ts:10-20
export type ProviderDelta =
  | { type: "text"; text: string }
  | { type: "tool_use"; callId: string; tool: string; input: unknown }
  | { type: "finish"; reason: "end_turn" | "tool_use" | "stop" }
  | { type: "provider_switch"; from: string; to: string; reason: string };
```

`text` streams a chunk of assistant-visible prose. `tool_use` asks the orchestrator to
execute a named tool with some input and report back. `finish` ends the turn. The fourth,
`provider_switch`, is not something a real model API sends — it's a synthetic delta a
router-wrapped provider list emits to signal a failover happened (see `ProviderRouter`
below); `MockProvider` also emits it directly for one of its own scripted demo scenarios, so
the frontend's failover UX is exercised even with a single-provider setup.

### `TurnContext` — what the provider is given each turn

```ts
// apps/backend/src/providers/types.ts:29-39
export interface TurnContext {
  userMessage: string;
  currentGraph: WorkflowGraph;
  catalog: NodeDefinitionDto[];
  attempt: number;
  priorErrors?: ValidationError[];
  lastChangeSummary?: string;
  isFirstVersion?: boolean;
}
```

`attempt` and `priorErrors` are what make self-correction possible: if attempt 1's proposal
failed validation, the orchestrator re-invokes `provider.run(ctx)` with `attempt: 2` and
`priorErrors` set to what went wrong — "exactly as a real tool-use conversation would replay
the tool_result content back to the model" (the field's own doc comment,
`types.ts:23-27`). `lastChangeSummary`/`isFirstVersion` exist purely so "explain" turns can
answer "why did you make that change" without a second database round-trip.

## `MockProvider` — the only provider that exists today

`providers/mock-provider.ts` (403 lines) is a deterministic, zero-API-key stand-in for a
real model. Its own file comment (`mock-provider.ts:1-13`) is precise about what it is: it
ports the *intent* of `apps/frontend/mock/scenarios.ts`'s keyword-driven "AI" into a real
`LlmProvider` — but critically, unlike the frontend mock (`11-mock-backend.md`), it never
mutates anything itself. Its `tool_use` deltas drive the *real* tool registry, which runs
the *real* validator, before anything is ever proposed.

### Scenario selection: one regex dispatch

```ts
// apps/backend/src/providers/mock-provider.ts:164-172
function pickScenario(lower: string): ScenarioKind {
  if (/\btimeout\b/.test(lower)) return "timeout";
  if (/\bfail\b/.test(lower)) return "fail";
  if (/\bprovider\b/.test(lower)) return "provider_switch";
  if (/\btool\b/.test(lower)) return "tool_failure";
  if (/\b(bad|broken)\b/.test(lower)) return "self_correct";
  if (/\bwhy\b/.test(lower) || /\bexplain\b/.test(lower)) return "explain";
  return "build";
}
```

Every user message maps to exactly one of 7 scripts based on keywords in the message —
this is the acknowledged simplification called out in `REMAINING.md`: "scenario selection is
keyword-based, not semantic intent classification." The 7 scripts, and what each
demonstrates:

| Scenario | Trigger keyword | Method | What it demonstrates |
|---|---|---|---|
| `build` | (default) | `runBuild` (`mock-provider.ts:212`) | The happy path: search → propose a valid mutation |
| `explain` | "why"/"explain" | `runExplain` (`mock-provider.ts:245`) | A non-mutating turn — no proposal, just text |
| `self_correct` | "bad"/"broken" | `runSelfCorrect` (`mock-provider.ts:268`) | Attempt 1 proposes invalid config (missing required field) on purpose; attempt 2 repairs it |
| `fail` | "fail" | `runFail` (`mock-provider.ts:315`) | Always hallucinates an unknown node type — exhausts the self-correction budget, ends in `run.failed` |
| `provider_switch` | "provider" | `runProviderSwitch` (`mock-provider.ts:338`) | Emits a synthetic `provider_switch` delta before proceeding normally |
| `tool_failure` | "tool" | `runToolFailure` (`mock-provider.ts:366`) | First `search_nodes` call fails (`_simulateFailure: true`), second succeeds |
| `timeout` | "timeout" | `runTimeout` (`mock-provider.ts:394`) | Yields one tool call, then an async generator that **never resolves** — the orchestrator's deadline race is what actually ends this run |

### `computeMutationOps` — turning a message into `Operation[]`

```ts
// apps/backend/src/providers/mock-provider.ts:59-153 (excerpt — the "create from nothing" branch)
if (!existingTrigger && hasStripe && (hasSlack || hasTeams)) {
  const trigger = makeNode("stripe.payment_received", { currency: "usd" });
  const actionType = hasTeams && !hasSlack ? "teams.send_message" : "slack.send_message";
  const action = makeNode(actionType, actionType === "teams.send_message" ? teamsConfig() : slackConfig());
  return {
    ops: [
      { op: "add_node", node: trigger },
      { op: "add_node", node: action },
      { op: "add_edge", edge: makeEdge(trigger.id, action.id) },
    ],
    summary: `Created a workflow: Stripe payment received → send a ${label} message.`,
    schemaType: actionType,
  };
}
```

This is the function behind "send a Slack message whenever Stripe receives a payment" —
notice it returns `Operation[]`, never a full graph, the same discipline
`03-the-core-invariant.md` requires everywhere else. `computeMutationOps`
(`mock-provider.ts:59`) pattern-matches on keywords (`hasStripe`, `hasSlack`, `hasThreshold`,
`hasWeekday`, etc.) against both the message and the *existing* graph — e.g. "add a
condition over $500" only makes sense if a trigger already exists, and either updates an
existing `filter.condition` node's config or inserts a new one via
`insertAfterTriggerOps` (`mock-provider.ts:43-56`, which rewires the trigger's outgoing edges
through the new node — this is the operation-based equivalent of what the frontend mock does
by mutating a whole graph directly, see `11-mock-backend.md`).

## The agent loop itself — `runOrchestrator`

```ts
// apps/backend/src/agent/orchestrator.ts:74-93
export async function runOrchestrator(
  provider: LlmProvider, runId: string, conversationId: string, workflowId: string, userMessage: string,
): Promise<void> {
  const deadline = createDeadline(env.RUN_DEADLINE_MS);
  const outcome = await Promise.race([
    mainLoop(provider, runId, conversationId, workflowId, userMessage),
    deadline.promise,
  ]);
  deadline.cancel();

  if (outcome === DEADLINE) {
    await appendEvent(runId, { event: "run.timeout", data: { runId, draftAvailable: false } });
    await prisma.run.update({ where: { id: runId }, data: { status: "timed_out" } }).catch(() => undefined);
    await clearRunState(runId);
  }
}
```

The whole function is a `Promise.race` between the real work (`mainLoop`) and a timer
(`createDeadline`, `orchestrator.ts:54-60`, `RUN_DEADLINE_MS`, default 6000ms). This is what
makes `MockProvider`'s `runTimeout` scenario — an async generator that never resolves — a
safe thing to run at all: no matter what a provider does, the run ends one way or another.
The doc comment right above the function states the contract plainly: **"Never throws —
every failure path emits a terminal SSE event and updates run.status before returning."**

### The self-correction budget

```ts
// apps/backend/src/agent/orchestrator.ts:129-134
const maxAttempts = env.SELF_CORRECTION_BUDGET + 1;
let attempt = 1;
let priorErrors: TurnContext["priorErrors"];
let accumulatedText = "";

while (attempt <= maxAttempts) {
```

`SELF_CORRECTION_BUDGET` defaults to 1 (PRD v1.1 Decision #2, `config/env.ts`), so
`maxAttempts` is 2: the original attempt plus one repair. Inside the loop, when a
`propose_operations` call comes back invalid (`orchestrator.ts:163-198`):

```ts
// apps/backend/src/agent/orchestrator.ts:168-184 (abridged)
await appendEvent(runId, { event: "validation.error", data: { errors: outcome.errors } });
if (attempt < maxAttempts) {
  await appendEvent(runId, { event: "retry", data: { attempt, max: maxAttempts, reason: "..." } });
  await appendEvent(runId, { event: "agent.step", data: { kind: "repair", label: `Fixing configuration (attempt ${attempt} of ${maxAttempts})` } });
  attempt += 1;
  priorErrors = outcome.errors;
  shouldRetryTurn = true;
  break;
}
// else: budget exhausted -> run.failed, no write, clearRunState
```

If the budget is exhausted, `run.failed` is emitted with the accumulated error codes and the
`Run.status` becomes `"failed"` — nothing is ever written to `workflow_version` on this
path (see `MockProvider`'s `fail` scenario, which is scripted to always hallucinate an
unknown node type specifically to exercise this).

### Cancellation — checked between every step, not just at the top

```ts
// apps/backend/src/agent/orchestrator.ts:29-33
async function tick(runId: string, ms: number): Promise<boolean> {
  await sleep(ms);
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { cancelRequested: true } });
  return !(run?.cancelRequested ?? false);
}
```

`tick` is called before nearly every state transition in `mainLoop` (planning, each tool
step, each retry pacing delay) — it's both a deliberate pacing delay (so the frontend's
activity timeline streams visibly instead of resolving in one tick, per the comment at
`orchestrator.ts:25-28`) and a cancellation checkpoint. `POST /api/runs/:runId/cancel`
(`08-api-and-runs.md`) just sets `Run.cancelRequested = true`; the *next* `tick()` call
anywhere in the loop is what actually stops execution and emits `run.cancelled`
(`cancelRun`, `orchestrator.ts:221-225`).

### The approval pause — `handleProposal`

This is where the loop hands off to a human — covered in full in
`03-the-core-invariant.md`'s "Follow the exact code path" section
(`orchestrator.ts:301-359`). The one-line summary for this chapter: on a valid proposal, the
loop stashes `Run.proposedOps`/`proposedGraph`, emits `workflow.proposed`, and returns
**without** looping again — the run stays `"running"` until `routes/runs.ts`'s approve/reject
handlers resolve it.

## `ProviderRouter` + `CircuitBreaker` — reliability without touching the loop

```ts
// apps/backend/src/providers/router.ts:24-69 (abridged)
export class ProviderRouter implements LlmProvider {
  readonly name = "router";
  private readonly breakers: CircuitBreaker[];

  constructor(private readonly providers: LlmProvider[]) {
    this.breakers = providers.map(() => new CircuitBreaker(env.PROVIDER_FAILURE_THRESHOLD, env.PROVIDER_BREAKER_COOLDOWN_MS));
  }

  async *run(ctx: TurnContext): AsyncIterable<ProviderDelta> {
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i], breaker = this.breakers[i];
      if (!breaker.canAttempt()) continue;
      try {
        for await (const delta of provider.run(ctx)) yield delta;
        breaker.onSuccess();
        return;
      } catch (err) {
        breaker.onFailure();
        const next = this.providers[i + 1];
        if (next) yield { type: "provider_switch", from: provider.name, to: next.name, reason: "..." };
      }
    }
    throw lastError ?? new ProviderError("all configured providers are unavailable", "router");
  }
}
```

The critical design point, stated in the file's own header comment
(`router.ts:1-11`): **`ProviderRouter` itself implements `LlmProvider`.** So
`agent/orchestrator.ts`'s single call site — `for await (const delta of provider.run(ctx))`
— never needs to change, whether it's talking to one provider, a router wrapping one
provider, or a router wrapping five. The router is entirely generic: "nothing here knows
'mock' from 'anthropic'" (same comment).

`CircuitBreaker` (`providers/circuit-breaker.ts`, 58 lines) is a textbook closed → open →
half-open state machine:

```ts
// apps/backend/src/providers/circuit-breaker.ts:29-52 (abridged)
canAttempt(): boolean {
  this.syncHalfOpen();       // OPEN -> HALF_OPEN once cooldownMs has elapsed
  return this.state !== "open";
}
onSuccess(): void { this.state = "closed"; this.consecutiveFailures = 0; }
onFailure(): void {
  this.syncHalfOpen();
  if (this.state === "half_open") { this.state = "open"; this.openedAt = this.now(); return; }
  this.consecutiveFailures += 1;
  if (this.consecutiveFailures >= this.failureThreshold) { this.state = "open"; this.openedAt = this.now(); }
}
```

`now` is an injected clock (`circuit-breaker.ts:20`, defaulting to `Date.now`) specifically
so tests can drive state transitions without real timers — see `13-testing.md`.
`PROVIDER_FAILURE_THRESHOLD` (default 3) and `PROVIDER_BREAKER_COOLDOWN_MS` (default 30000)
are both env-configurable (`14-ops-and-docker.md`).

**Documented, deliberate limitation** (`router.ts:13-18`): failover is connect-time /
first-delta only. If a provider throws *after* already yielding some deltas — a genuine
mid-stream failure — those deltas aren't retracted; the next provider's turn starts fresh.
This reads as "the answer cut off, then restarted" rather than silent duplication, and is
acceptable until `AnthropicProvider` makes mid-stream failures a real (not just
theoretical) case.

### `factory.ts` — the composition root

```ts
// apps/backend/src/providers/factory.ts:18-29
let cached: LlmProvider | undefined;

export function getProvider(): LlmProvider {
  if (cached) return cached;
  if (env.LLM_PROVIDER === "anthropic") {
    throw new Error("LLM_PROVIDER=anthropic is not implemented yet — see REMAINING.md...");
  }
  cached = new ProviderRouter([new MockProvider()]);
  return cached;
}
```

This is the one function `agent/orchestrator.ts`'s caller invokes to get a provider — today
it always returns a `ProviderRouter` wrapping a single-element `[MockProvider]` list, so the
breaker is real, tested, working code, just idle (nothing to fail over *to* yet). Adding a
real provider later is exactly `new ProviderRouter([new AnthropicProvider(), new
MockProvider()])` — see `15-extending.md`'s recipe.

## The four tools — the agent's only surface

`tools/registry.ts`'s `executeTool` (`registry.ts:20`) is the single dispatch point:

```ts
// apps/backend/src/tools/registry.ts:12-38 (abridged)
export const KNOWN_TOOLS = ["search_nodes", "get_node_schema", "get_current_workflow", "propose_operations"] as const;

export async function executeTool(ctx: ToolContext, tool: string, input: unknown): Promise<ToolResult> {
  switch (tool as ToolName) {
    case "search_nodes": return searchNodes(ctx, input as SearchNodesInput);
    case "get_node_schema": return getNodeSchema(ctx, input as { type: string });
    case "get_current_workflow": return getCurrentWorkflow(ctx);
    case "propose_operations": { const { ops } = input as { ops: Operation[] }; return { ok: true, result: proposeOperations(ctx, ops) }; }
    default: return { ok: false, error: `unknown tool "${tool}"; allowed: ${KNOWN_TOOLS.join(", ")}` };
  }
}
```

Centralizing dispatch here — rather than letting the orchestrator switch on tool name
itself — is what makes "the agent calls an invalid tool" a one-line `default` case instead
of a thrown exception (`registry.ts:1-5`'s comment).

| Tool | File | Writes? | What it does |
|---|---|---|---|
| `search_nodes` | `read-tools.ts:25` (`searchNodes`) | No | pgvector search first, keyword fallback — see below |
| `get_node_schema` | `read-tools.ts:39` | No | Returns a catalog entry's `configSchema` |
| `get_current_workflow` | `read-tools.ts:45` | No | Returns `{ nodeCount, graph }` for the workflow's current graph |
| `propose_operations` | `propose-operations.ts:17` | **No** — validates only | Runs `applyOperations` + `validateGraph`, returns a `ProposeOutcome` |

### `propose_operations` — same core, no write

```ts
// apps/backend/src/tools/propose-operations.ts:17-21 (full function)
export function proposeOperations(ctx: ToolContext, ops: Operation[]): ProposeOutcome {
  const candidate = applyOperations(ctx.currentGraph, ops);
  const result = validateGraph(candidate, ctx.catalogEntries);
  return result.valid ? { valid: true, graph: result.graph } : { valid: false, errors: result.errors };
}
```

This is the same `applyOperations`/`validateGraph` pair from `06-deterministic-core.md`,
called here purely to check a proposal is legal — no Prisma call, no transaction. The
*exact same* validator will run again at commit time (`tools/commit.ts` →
`core/version-applier.ts`), which is what lets the orchestrator trust a "valid" result enough
to show it to a human as `workflow.proposed`, while still not skipping re-validation later.

### `search_nodes` and the pgvector RAG path

```ts
// apps/backend/src/tools/read-tools.ts:25-37
export async function searchNodes(ctx: ToolContext, input: SearchNodesInput): Promise<ToolResult> {
  if (input._simulateFailure) return { ok: false, error: "node search index temporarily unavailable" };

  if (input.query) {
    const vectorMatches = await searchNodesByVector(ctx.prisma, embedder, input.query, 5);
    if (vectorMatches.length > 0) return { ok: true, result: vectorMatches };
  }

  const matches = searchCatalog(ctx.catalog, input.query).map((n) => n.type);
  return { ok: true, result: matches.length > 0 ? matches : ctx.catalog.map((n) => n.type) };
}
```

Semantic search first, keyword fallback second — and the fallback isn't an error path, it's
the *expected* path whenever nothing has an embedding yet (before
`workers/embedding-worker.ts`'s backfill has run) or nothing scores a vector match
(`read-tools.ts:17-24`'s doc comment). `searchNodesByVector`
(`catalog/vector-search.ts:10-32`) embeds the query with `MockEmbedder`
(`embeddings/mock-embedder.ts` — a deterministic FNV-1a feature-hashing bag-of-words
embedder, zero API cost, `mock-embedder.ts:1-7`'s comment explains the tradeoff explicitly)
and runs a raw SQL query using pgvector's `<=>` cosine-distance operator:

```sql
-- apps/backend/src/catalog/vector-search.ts:22-27
SELECT type FROM node_definition
WHERE embedding IS NOT NULL
ORDER BY embedding <=> ${literal}::vector
LIMIT ${k}
```

It returns `[]` — not a thrown error — on any failure or empty result
(`vector-search.ts:29-31`'s `catch { return []; }`), which is exactly what makes the
keyword fallback in `searchNodes` safe to fall through to unconditionally. See
`09-workers.md` for how embeddings actually get computed and written.

## `_simulateFailure` — how the tool-failure demo works without a real failure

Notice `SearchNodesInput._simulateFailure` (`read-tools.ts:11-15`) — a field no real
provider would ever set, used only by `MockProvider.runToolFailure`
(`mock-provider.ts:366`) to make the *first* `search_nodes` call fail on purpose and the
*second* succeed, demonstrating the orchestrator's tolerance of a failed (non-`propose_
operations`) tool call without any special-casing in the orchestrator itself — a failed
`tool.result` just isn't terminal (`handleDelta`'s fallthrough,
`orchestrator.ts:293-298`) unless it's specifically a failed `propose_operations`.

---
**Prev:** [`06-deterministic-core.md`](./06-deterministic-core.md) · **Next:**
[`08-api-and-runs.md`](./08-api-and-runs.md) · **Related:**
[`03-the-core-invariant.md`](./03-the-core-invariant.md),
[`09-workers.md`](./09-workers.md), [`15-extending.md`](./15-extending.md)
