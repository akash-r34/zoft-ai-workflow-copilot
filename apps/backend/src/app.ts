// Builds the Fastify instance: CORS, error handling, and every route module.
// Kept separate from index.ts (which only boots/listens) so tests can build
// an app instance with app.inject() without binding a real port.
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./config/env.js";
import { registerErrorHandler } from "./routes/errors.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerNodeDefinitionRoutes } from "./routes/node-definitions.js";
import { registerDevRoutes } from "./routes/dev.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  // Mirrors apps/frontend/mock/server.ts's CORS config exactly — the
  // frontend's SSE client sends a Last-Event-ID header on reconnect, which
  // must be explicitly allowed or the browser blocks the request.
  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    allowedHeaders: ["Content-Type", "Last-Event-ID"],
  });

  registerErrorHandler(app);
  registerHealthRoute(app);
  registerConversationRoutes(app);
  registerRunRoutes(app);
  registerWorkflowRoutes(app);
  registerNodeDefinitionRoutes(app);
  registerDevRoutes(app);

  return app;
}
