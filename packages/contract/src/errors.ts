import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "NODE_NOT_FOUND",
  "WORKFLOW_NOT_FOUND",
  "RUN_NOT_FOUND",
  "CONVERSATION_NOT_FOUND",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code:    ErrorCodeSchema,
  message: z.string(),
  details: z.array(z.unknown()).optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: ApiErrorSchema,
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
