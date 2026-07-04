// Error envelope + Fastify error handler. Byte-compatible with
// apps/frontend/mock/server.ts's ApiErrorException + setErrorHandler so
// apps/frontend/src/lib/api.ts's ApiRequestError decoding needs no changes.
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { ErrorCode } from "@zoft/contract";

export class ApiErrorException extends Error {
  code: ErrorCode;
  status: number;
  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ApiErrorException) {
      void reply.code(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof ZodError) {
      void reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: err.message } });
      return;
    }
    // Fastify's own request-parsing errors (e.g. a stray Content-Type header
    // on a bodyless POST) carry a 4xx statusCode — surface those as client
    // errors instead of masking them as a 500.
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      void reply.code(err.statusCode).send({ error: { code: "VALIDATION_FAILED", message: err.message } });
      return;
    }
    app.log.error(err);
    void reply.code(500).send({ error: { code: "INTERNAL", message: err.message } });
  });
}
