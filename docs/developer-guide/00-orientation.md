# 00 — Orientation: What This Is and Why

> Anchored to commit `8df9601`. See `INDEX.md` for the full legend. This chapter has no
> code in it deliberately — read it first to build intuition before opening a single file.

## The problem this product solves

Automation tools like Zapier or n8n let you wire "when X happens, do Y" — but building a
workflow means clicking through a node picker, wiring edges by hand, and configuring each
step's settings in a form. Zoft's pitch: describe what you want in plain English, and an AI
assistant builds, edits, and explains the workflow for you, through a conversational chat
interface, while showing its work as it goes.

## A concrete walkthrough

You open the app and type:

> "send a Slack message whenever Stripe receives a payment"

Within a couple of seconds you see, streaming in real time: "Planning workflow…",
"Searching available nodes…", "Reading node schema…", "Calling validator…" — a visible
trace of the AI's reasoning, not just a spinner. Then a panel appears: **"Review proposed
change"** with a summary and a visual diff — a new Stripe trigger connected to a new Slack
action. You click **Approve**. The panel disappears, the graph on the right updates with a
brief highlight around the new nodes, and the chat shows the AI's confirmation.

Now you type:

> "only send it for payments over $500"

The AI recognizes there's already a trigger, adds a filter condition node between the
trigger and the Slack action, and proposes that change the same way — another approval, another
diff, another update.

Later you ask:

> "why did you add that filter?"

No new proposal this time — just a text answer, because this message doesn't describe a
change; it's a question about the existing workflow.

Every one of these turns is called a **run**, and every accepted change produces a new,
permanent **version** of the workflow you can look back at, compare, or restore.

## The mental model: three moving parts

1. **A chat conversation** — an ordinary back-and-forth of user and assistant messages.
2. **A workflow** — the actual automation being built: a graph of trigger and action nodes
   connected by edges. Every conversation is eventually linked to one workflow (created the
   first time the conversation produces a change).
3. **Runs** — one per user message, each a full round trip: the AI reasons, proposes a
   change (or just answers), a human approves or rejects any proposed change, and the run
   ends in one of several defined outcomes (succeeded, failed, cancelled, timed out).

The single rule that ties all three together, and the one idea worth internalizing before
anything else in this guide:

> **The AI proposes. It never decides. A human approves, and only then does deterministic
> code — not the AI — write anything.**

`03-the-core-invariant.md` is the whole chapter on why and how; everything else in this
guide either builds up to that gate or builds on top of it.

## Glossary

| Term | Meaning |
|---|---|
| **Workflow** | The automation itself — a graph of nodes and edges. Has a name and a pointer to its current version. |
| **Node** | One step in a workflow — either a **trigger** (what starts it, e.g. "Stripe: Payment Received") or an **action** (what it does, e.g. "Slack: Send Message"). Every node has a `type` (a catalog key) and a `config` (its settings). |
| **Edge** | A connection from one node to another — "after this happens, do that next." |
| **Node catalog** | The fixed list of available node types the workflow can be built from (5 seeded today: a Stripe trigger, Slack/Teams actions, a value filter, a weekday filter). Data-driven — adding a type is a data row, not a code change. |
| **Operation** | One small, well-defined edit to a graph — "add this node," "remove this edge," "set this config field." The AI never proposes a whole new graph, only a list of operations. |
| **Run** | One full AI turn: from a user's message to a terminal outcome (succeeded / failed / cancelled / timed out). |
| **Proposal / the approval gate** | Once the AI's operations produce a graph that passes validation, the run pauses and shows the human a diff. Nothing is saved until they click Approve (or the change is discarded on Reject). |
| **Version** | An immutable, permanent snapshot of a workflow's graph, created only when a proposal is approved (or a past version is restored). Versions are never edited or deleted — only appended, forming a full history. |
| **Validation** | The deterministic (non-AI) check that a candidate graph is legal: every node type exists in the catalog, every node's config matches its schema, the graph has exactly one trigger and no cycles or orphans, and connected nodes have compatible types. |
| **Self-correction** | If a proposal fails validation, the AI gets one (configurable) chance to see the errors and try again before the run gives up. |
| **Provider** | The thing that actually "thinks" — today, a deterministic scripted stand-in (`MockProvider`) rather than a real LLM API, so the whole system runs with zero API keys and zero cost. |

## What this guide covers, and what it doesn't

This guide explains the **codebase as it exists today** — a real, working system with a
deterministic stand-in for the AI ("provider"), not a tutorial on prompt engineering or LLM
integration. Read `07-agent-and-providers.md` for exactly how a real AI provider would slot
in later with no other code changes, and `REMAINING.md` (repo root) for the one piece
deliberately left unbuilt (a real Anthropic-backed provider — it needs a paid API key to
ever verify, so it's out of scope for this codebase in its current state).

---
**Next:** [`01-getting-started.md`](./01-getting-started.md) · **Related:**
[`03-the-core-invariant.md`](./03-the-core-invariant.md)
