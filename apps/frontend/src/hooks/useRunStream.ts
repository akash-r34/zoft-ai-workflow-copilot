// Bridges the SSE transport (lib/sse.ts) into the run-store, and invalidates
// the TanStack Query caches that the stream's events make stale: a
// workflow.updated means the workflow/versions queries are behind, a
// terminal event means the message list now has the assistant's reply.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openRunStream } from "../lib/sse";
import { useRunStore } from "../stores/run-store";

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled", "run.timeout"]);

export function useRunStream(conversationId: string | null, workflowId: string | null): void {
  const runId = useRunStore((s) => s.runId);
  const addEvent = useRunStore((s) => s.addEvent);
  const setConnectionStatus = useRunStore((s) => s.setConnectionStatus);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!runId) return;

    const close = openRunStream(runId, {
      onEvent: (evt) => {
        addEvent(evt);

        if (evt.event === "workflow.updated") {
          void queryClient.invalidateQueries({ queryKey: ["workflow", workflowId] });
          void queryClient.invalidateQueries({ queryKey: ["versions", workflowId] });
        }

        if (TERMINAL_EVENTS.has(evt.event)) {
          void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
          close();
        }
      },
      onStatusChange: setConnectionStatus,
    });

    return close;
  }, [runId, conversationId, workflowId, addEvent, setConnectionStatus, queryClient]);
}
