// The deterministic core does not define its own domain types. Every shape
// here — WorkflowNode, WorkflowEdge, WorkflowGraph, the Operation union,
// ValidationError/Result, CatalogEntry — already lives in `@zoft/contract`,
// the single enforced boundary between backend and frontend (see CLAUDE.md:
// "Never define a shared type outside packages/contract"). This file exists
// only so the rest of `core/` has a stable local import point
// (`./types.js`) without every file reaching into the workspace package
// directly, and so a future contract change surfaces here first.

export type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowGraph,
  Operation,
  ValidationError,
  ValidationResult,
  CatalogEntry,
} from "@zoft/contract";

// EMPTY_GRAPH is a runtime value (not a type), so it needs a value export,
// not `export type`.
export { EMPTY_GRAPH } from "@zoft/contract";
