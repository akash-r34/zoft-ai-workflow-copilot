// Worker-process entrypoint — a separate Node process from the API server
// (src/index.ts), started via `pnpm --filter @zoft/backend worker` (or the
// `worker` service in infra/docker-compose.yml). Boots all three BullMQ
// workers, registers the archival repeatable (cron) job, and backfills any
// catalog row still missing an embedding.
import { env } from "../config/env.js";
import { registerArchivalRepeatable } from "../queues/queues.js";
import { enqueueMissingEmbeddings, startEmbeddingWorker } from "./embedding-worker.js";
import { startValidationWorker } from "./validation-worker.js";
import { startArchivalWorker } from "./archival-worker.js";

async function main(): Promise<void> {
  const embeddingWorker = startEmbeddingWorker();
  const validationWorker = startValidationWorker();
  const archivalWorker = startArchivalWorker();

  await registerArchivalRepeatable(env.ARCHIVE_CRON);
  const backfilled = await enqueueMissingEmbeddings();
  console.warn(
    `worker: started (embedding, validation, archival); enqueued ${backfilled} missing embedding(s); archival cron="${env.ARCHIVE_CRON}"`,
  );

  const shutdown = async (): Promise<void> => {
    await Promise.all([embeddingWorker.close(), validationWorker.close(), archivalWorker.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void main();
