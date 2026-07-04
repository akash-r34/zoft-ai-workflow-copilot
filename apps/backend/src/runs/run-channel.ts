// Redis pub/sub transport for a run's live event fan-out — replaces
// event-bus.ts's old in-process `Map<runId, Set<listener>>`, which couldn't
// fan out to any SSE connection served by a different process. Postgres
// `run_event` (event-bus.ts's getEventsSince) remains the sole replay
// source; this module only carries the LIVE tail.
import type { SseEvent } from "@zoft/contract";
import { createSubscriber, getRedis } from "../redis/connection.js";

function channelFor(runId: string): string {
  return `run:${runId}`;
}

export async function publishRunEvent(runId: string, evt: SseEvent): Promise<void> {
  await getRedis().publish(channelFor(runId), JSON.stringify(evt));
}

/** Subscribes to a run's live channel; returns an unsubscribe function that also tears down the dedicated connection this call created (see redis/connection.ts's createSubscriber doc — a subscribed connection can't run other commands, so it can't be shared). */
export async function subscribeToRun(
  runId: string,
  onEvent: (evt: SseEvent) => void,
): Promise<() => Promise<void>> {
  const subscriber = createSubscriber();
  const channel = channelFor(runId);

  subscriber.on("message", (ch: string, message: string) => {
    if (ch !== channel) return;
    try {
      onEvent(JSON.parse(message) as SseEvent);
    } catch {
      // Malformed payload should never happen — we control the only publisher.
    }
  });

  await subscriber.subscribe(channel);

  return async () => {
    await subscriber.unsubscribe(channel);
    await subscriber.quit();
  };
}
