// Shared shapes for the agent's tool layer. Tools are the only surface the
// provider can act through — read-only tools (search_nodes, get_node_schema,
// get_current_workflow) never touch the database; propose_operations runs the
// real deterministic validator but never writes; commit is the sole write path
// (see tools/commit.ts), and even it only ever runs after a human approval
// (see agent/orchestrator.ts + routes/runs.ts).
import type { CatalogEntry, NodeDefinitionDto, WorkflowGraph } from "@zoft/contract";
import type { PrismaClient } from "@prisma/client";

export interface ToolContext {
  prisma: PrismaClient;
  workflowId: string;
  catalog: NodeDefinitionDto[];
  catalogEntries: CatalogEntry[];
  currentGraph: WorkflowGraph;
}

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };
