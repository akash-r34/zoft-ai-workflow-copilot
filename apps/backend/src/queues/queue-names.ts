// Central registry of BullMQ queue names + their payload shapes, so a typo'd
// queue name can't silently create a queue nobody's Worker is listening on
// (every producer and consumer imports the same QUEUE constant).
export const QUEUE = {
  embedding: "embedding",
  validation: "validation",
  archival: "archival",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface EmbeddingJobPayload {
  nodeType: string;
}

/** No fields needed today — the validation worker sweeps every workflow each run (see workers/validation-worker.ts). Kept as a real object, not undefined, so a future single-workflow trigger is an additive change. */
export interface ValidationJobPayload {
  triggeredBy: "scheduled" | "manual";
}

export interface ArchivalJobPayload {
  triggeredBy: "scheduled" | "manual";
}
