// propose_operations: runs the SAME deterministic core (applyOperations +
// validateGraph) that the eventual commit will re-run, but never writes.
// This is the tool that turns an agent's ops into either a validated
// candidate graph (which becomes a workflow.proposed SSE event awaiting human
// approval) or a structured error list the orchestrator feeds back into a
// self-correction retry. See CLAUDE.md's core invariant: the AI proposes,
// deterministic code validates.
import { applyOperations } from "../core/applier.js";
import { validateGraph } from "../core/validator.js";
import type { Operation, ValidationError, WorkflowGraph } from "../core/types.js";
import type { ToolContext } from "./types.js";

export type ProposeOutcome =
  | { valid: true; graph: WorkflowGraph }
  | { valid: false; errors: ValidationError[] };

export function proposeOperations(ctx: ToolContext, ops: Operation[]): ProposeOutcome {
  const candidate = applyOperations(ctx.currentGraph, ops);
  const result = validateGraph(candidate, ctx.catalogEntries);
  return result.valid ? { valid: true, graph: result.graph } : { valid: false, errors: result.errors };
}
