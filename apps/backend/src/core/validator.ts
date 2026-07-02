// Named import (not `import Ajv from "ajv"`) sidesteps a default-export
// interop mismatch between ajv's CJS runtime output and its ESM-style .d.ts
// under `moduleResolution: NodeNext` — `Ajv` is exported both as the default
// and as a named class export, so this resolves the same class cleanly.
import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import type {
  CatalogEntry,
  ValidationError,
  ValidationResult,
  WorkflowGraph,
} from "./types.js";

/**
 * Validates a candidate workflow graph against the node catalog and the
 * structural/type rules a graph must satisfy before it can be persisted.
 *
 * Runs every check and collects all resulting errors — it never
 * short-circuits on the first failure:
 *   1. Catalog membership          -> UNKNOWN_NODE_TYPE
 *   2. Config schema (Ajv)         -> INVALID_CONFIG
 *   3. Structure (DAG, one trigger, no dangling edges, full reachability)
 *                                  -> TRIGGER_COUNT, CYCLE_DETECTED,
 *                                     DANGLING_EDGE, ORPHAN_NODE
 *   4. Edge type compatibility     -> TYPE_MISMATCH
 *   5. Trigger rules (no inbound edges into a trigger) -> TRIGGER_HAS_INBOUND
 *
 * An empty graph (`nodes: []`) is valid: every workflow starts from
 * EMPTY_GRAPH, so an in-progress candidate with zero nodes must be
 * representable rather than rejected for lacking a trigger.
 *
 * Pure and synchronous. No side effects; does not mutate `graph` or `catalog`.
 *
 * @param graph - candidate graph to validate
 * @param catalog - node type definitions the graph's nodes are checked against
 * @returns `{ valid: true, graph }` (the same graph instance) if no errors were found, else `{ valid: false, errors }`
 */
export function validateGraph(graph: WorkflowGraph, catalog: CatalogEntry[]): ValidationResult {
  const errors: ValidationError[] = [];
  const catalogByType = new Map(catalog.map((entry) => [entry.type, entry]));

  checkCatalogMembership(graph, catalogByType, errors);
  checkConfigSchemas(graph, catalogByType, errors);
  checkStructure(graph, catalogByType, errors);
  checkTypeCompatibility(graph, catalogByType, errors);
  checkTriggerRules(graph, catalogByType, errors);

  return errors.length === 0 ? { valid: true, graph } : { valid: false, errors };
}

// ── Check 1: catalog membership ────────────────────────────────────────────

function checkCatalogMembership(
  graph: WorkflowGraph,
  catalog: Map<string, CatalogEntry>,
  errors: ValidationError[],
): void {
  for (const node of graph.nodes) {
    if (!catalog.has(node.type)) {
      errors.push({
        code: "UNKNOWN_NODE_TYPE",
        message: `Node type "${node.type}" does not exist in the catalog`,
        nodeId: node.id,
      });
    }
  }
}

// ── Check 2: config schema (Ajv) ───────────────────────────────────────────

function checkConfigSchemas(
  graph: WorkflowGraph,
  catalog: Map<string, CatalogEntry>,
  errors: ValidationError[],
): void {
  const ajv = new Ajv({ allErrors: true });
  const compiled = new Map<string, ValidateFunction>();

  for (const node of graph.nodes) {
    const entry = catalog.get(node.type);
    if (!entry) continue; // already reported as UNKNOWN_NODE_TYPE

    let validate = compiled.get(node.type);
    if (!validate) {
      validate = ajv.compile(entry.configSchema);
      compiled.set(node.type, validate);
    }

    if (!validate(node.config)) {
      for (const ajvError of validate.errors ?? []) {
        errors.push({
          code: "INVALID_CONFIG",
          message: formatAjvError(ajvError),
          nodeId: node.id,
        });
      }
    }
  }
}

function formatAjvError(err: ErrorObject): string {
  const path = err.instancePath || "(root)";
  return `${path} ${err.message ?? "is invalid"}`.trim();
}

// ── Check 3: structure ──────────────────────────────────────────────────────

function checkStructure(
  graph: WorkflowGraph,
  catalog: Map<string, CatalogEntry>,
  errors: ValidationError[],
): void {
  // 3c. Dangling edges — checked unconditionally.
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      errors.push({
        code: "DANGLING_EDGE",
        message: `Edge "${edge.id}" references a node that does not exist in the graph`,
        edgeId: edge.id,
      });
    }
  }

  // 3b. Cycles — checked unconditionally.
  if (hasCycle(graph)) {
    errors.push({ code: "CYCLE_DETECTED", message: "Workflow contains a cycle" });
  }

  // Empty graph: nothing left to check (no trigger to require, nothing to
  // reach). See module doc for rationale.
  if (graph.nodes.length === 0) return;

  // 3a. Exactly one trigger.
  const triggers = graph.nodes.filter((n) => catalog.get(n.type)?.category === "trigger");
  if (triggers.length !== 1) {
    errors.push({
      code: "TRIGGER_COUNT",
      message: "Workflow must have exactly one trigger node",
    });
    return; // "reachable from the trigger" is undefined without exactly one
  }

  // 3d. Every non-trigger node reachable from the trigger.
  const trigger = triggers[0];
  if (!trigger) return; // unreachable: triggers.length === 1 was just checked
  const reachable = reachableFrom(trigger.id, graph);
  for (const node of graph.nodes) {
    if (node.id !== trigger.id && !reachable.has(node.id)) {
      errors.push({
        code: "ORPHAN_NODE",
        message: `Node "${node.id}" is not reachable from the trigger node`,
        nodeId: node.id,
      });
    }
  }
}

function buildAdjacency(graph: WorkflowGraph): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }
  return adjacency;
}

function hasCycle(graph: WorkflowGraph): boolean {
  const adjacency = buildAdjacency(graph);
  const state = new Map<string, "visiting" | "done">();

  const visit = (nodeId: string): boolean => {
    const current = state.get(nodeId);
    if (current === "visiting") return true;
    if (current === "done") return false;

    state.set(nodeId, "visiting");
    for (const next of adjacency.get(nodeId) ?? []) {
      if (visit(next)) return true;
    }
    state.set(nodeId, "done");
    return false;
  };

  for (const node of graph.nodes) {
    if (visit(node.id)) return true;
  }
  return false;
}

function reachableFrom(startId: string, graph: WorkflowGraph): Set<string> {
  const adjacency = buildAdjacency(graph);
  const visited = new Set<string>([startId]);
  const queue = [startId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  return visited;
}

// ── Check 4: edge type compatibility ────────────────────────────────────────

function checkTypeCompatibility(
  graph: WorkflowGraph,
  catalog: Map<string, CatalogEntry>,
  errors: ValidationError[],
): void {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const edge of graph.edges) {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (!sourceNode || !targetNode) continue; // already reported as DANGLING_EDGE

    const sourceEntry = catalog.get(sourceNode.type);
    const targetEntry = catalog.get(targetNode.type);
    if (!sourceEntry || !targetEntry) continue; // already reported as UNKNOWN_NODE_TYPE

    const outputTypes = sourceEntry.outputs.map((o) => o.type);
    const inputTypes = targetEntry.inputs.map((i) => i.type);

    const compatible =
      outputTypes.includes("any") ||
      inputTypes.includes("any") ||
      outputTypes.some((t) => inputTypes.includes(t));

    if (!compatible) {
      errors.push({
        code: "TYPE_MISMATCH",
        message: `Edge "${edge.id}" connects incompatible types: [${outputTypes.join(", ")}] -> [${inputTypes.join(", ")}]`,
        edgeId: edge.id,
      });
    }
  }
}

// ── Check 5: trigger rules ──────────────────────────────────────────────────

function checkTriggerRules(
  graph: WorkflowGraph,
  catalog: Map<string, CatalogEntry>,
  errors: ValidationError[],
): void {
  const targetIds = new Set(graph.edges.map((e) => e.target));

  for (const node of graph.nodes) {
    if (catalog.get(node.type)?.category === "trigger" && targetIds.has(node.id)) {
      errors.push({
        code: "TRIGGER_HAS_INBOUND",
        message: "Trigger nodes cannot be edge targets",
        nodeId: node.id,
      });
    }
  }
}
