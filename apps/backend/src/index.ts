import Fastify from "fastify";
import type { WorkflowGraph } from "@zoft/contract";

// WorkflowGraph is imported to confirm @zoft/contract is importable from backend.
// Used in type position only; no runtime reference needed in this scaffold.
type _GraphCheck = WorkflowGraph;

const server = Fastify({
  logger: {
    level: process.env["LOG_LEVEL"] ?? "info",
  },
});

const PORT = Number(process.env["PORT"] ?? 3001);
const HOST = process.env["HOST"] ?? "0.0.0.0";

const start = async (): Promise<void> => {
  try {
    await server.listen({ port: PORT, host: HOST });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

void start();
