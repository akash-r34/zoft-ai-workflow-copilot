import type { Operation, WorkflowGraph, WorkflowNode } from "./types.js";

/**
 * Applies an ordered list of operations to a workflow graph and returns a new
 * graph reflecting them.
 *
 * Contract:
 * - Pure and synchronous. Never mutates `graph` or any operation payload.
 * - Never throws. An operation that references a missing node/edge id (e.g.
 *   `remove_node` for an id not in the graph) is skipped and processing
 *   continues with the next operation — structural correctness (dangling
 *   edges, orphan nodes, etc.) is the validator's job, not the applier's.
 * - `remove_node` removes only the node itself; it does NOT cascade-delete
 *   edges that reference it. A caller that removes a node must also remove
 *   its edges, or the validator will report DANGLING_EDGE — this keeps the
 *   applier's behavior limited to exactly what each operation says.
 * - `update_node_config` REPLACES a node's `config` object wholesale (not a
 *   deep merge). Use `set_node_config_field` for a single nested-path edit.
 * - `replace_node` swaps `type` and `config`; `id` and `position` are
 *   preserved.
 *
 * @param graph - the current graph (read-only; not mutated)
 * @param ops - operations to apply, in order
 * @returns a new WorkflowGraph with every operation applied
 */
export function applyOperations(graph: WorkflowGraph, ops: Operation[]): WorkflowGraph {
  let next: WorkflowGraph = structuredClone(graph);

  for (const op of ops) {
    next = applyOne(next, op);
  }

  return next;
}

function applyOne(graph: WorkflowGraph, op: Operation): WorkflowGraph {
  switch (op.op) {
    case "add_node":
      return { ...graph, nodes: [...graph.nodes, structuredClone(op.node)] };

    case "remove_node": {
      if (!graph.nodes.some((n) => n.id === op.nodeId)) return graph;
      return { ...graph, nodes: graph.nodes.filter((n) => n.id !== op.nodeId) };
    }

    case "update_node_config":
      return withNode(graph, op.nodeId, (node) => ({
        ...node,
        config: structuredClone(op.config),
      }));

    case "replace_node":
      return withNode(graph, op.nodeId, (node) => ({
        ...node,
        type: op.newType,
        config: structuredClone(op.config),
      }));

    case "add_edge":
      return { ...graph, edges: [...graph.edges, structuredClone(op.edge)] };

    case "remove_edge": {
      if (!graph.edges.some((e) => e.id === op.edgeId)) return graph;
      return { ...graph, edges: graph.edges.filter((e) => e.id !== op.edgeId) };
    }

    case "set_node_config_field":
      return withNode(graph, op.nodeId, (node) => {
        const config = structuredClone(node.config);
        setPath(config, op.path, op.value);
        return { ...node, config };
      });

    default: {
      // Exhaustiveness guard: if the contract's Operation union grows a new
      // variant without this switch being updated, TS fails the build here.
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

/** Returns a new graph with the node matching `nodeId` replaced by `update(node)`; a no-op if the id is not found. */
function withNode(
  graph: WorkflowGraph,
  nodeId: string,
  update: (node: WorkflowNode) => WorkflowNode,
): WorkflowGraph {
  const idx = graph.nodes.findIndex((n) => n.id === nodeId);
  const existing = idx === -1 ? undefined : graph.nodes[idx];
  if (idx === -1 || existing === undefined) return graph;

  const nodes = [...graph.nodes];
  nodes[idx] = update(existing);
  return { ...graph, nodes };
}

/** Sets `value` at a dot-notation `path` inside `obj`, creating intermediate objects as needed. */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cursor: Record<string, unknown> = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    const child = cursor[key];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];
  if (lastKey !== undefined) {
    cursor[lastKey] = value;
  }
}
