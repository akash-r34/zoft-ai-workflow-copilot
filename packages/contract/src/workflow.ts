export interface WorkflowNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };

export type OperationKind =
  | "add_node"
  | "remove_node"
  | "update_node_config"
  | "replace_node"
  | "add_edge"
  | "remove_edge"
  | "set_node_config_field";

export type Operation =
  | { op: "add_node";              node: WorkflowNode }
  | { op: "remove_node";           nodeId: string }
  | { op: "update_node_config";    nodeId: string; config: Record<string, unknown> }
  | { op: "replace_node";          nodeId: string; newType: string; config: Record<string, unknown> }
  | { op: "add_edge";              edge: WorkflowEdge }
  | { op: "remove_edge";           edgeId: string }
  | { op: "set_node_config_field"; nodeId: string; path: string; value: unknown };

export interface ValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export type ValidationResult =
  | { valid: true;  graph: WorkflowGraph }
  | { valid: false; errors: ValidationError[] };

export interface CatalogEntry {
  type: string;
  category: "trigger" | "action";
  configSchema: Record<string, unknown>;
  inputs:  Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
}
