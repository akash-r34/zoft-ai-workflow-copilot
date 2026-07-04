// Thin EventSource wrapper for GET /api/runs/:runId/stream. EventSource
// gives us reconnection and Last-Event-ID replay for free (per
// Plans/04-api-contract.md) — this module just adapts it to a callback pair
// and layers a heartbeat watchdog on top, since a silently-dead proxy can
// leave readyState at OPEN with no more frames arriving.
import type { SseEvent } from "@zoft/contract";
import { runStreamUrl } from "./api";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "closed";

export interface RunStreamHandlers {
  onEvent: (evt: SseEvent) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

const HEARTBEAT_TIMEOUT_MS = 20_000;

interface RawStreamEvent {
  event: string;
  data: unknown;
  seq: number;
}

function isSseEvent(value: RawStreamEvent): value is SseEvent {
  return value.event !== "heartbeat";
}

/** Opens the run stream and returns a cleanup function that closes it. */
export function openRunStream(runId: string, handlers: RunStreamHandlers): () => void {
  const source = new EventSource(runStreamUrl(runId));
  let status: ConnectionStatus = "connecting";
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let closedByCaller = false;

  function setStatus(next: ConnectionStatus): void {
    if (status === next) return;
    status = next;
    handlers.onStatusChange(next);
  }

  function resetHeartbeatWatchdog(): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (!closedByCaller) setStatus("reconnecting");
    }, HEARTBEAT_TIMEOUT_MS);
  }

  source.onopen = () => {
    setStatus("connected");
    resetHeartbeatWatchdog();
  };

  source.onmessage = (event: MessageEvent<string>) => {
    resetHeartbeatWatchdog();
    setStatus("connected");
    const parsed = JSON.parse(event.data) as RawStreamEvent;
    if (isSseEvent(parsed)) handlers.onEvent(parsed);
  };

  source.onerror = () => {
    if (closedByCaller) return;
    setStatus(source.readyState === EventSource.CONNECTING ? "reconnecting" : "closed");
  };

  return () => {
    closedByCaller = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    source.close();
  };
}
