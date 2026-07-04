"use client";

import { buildTimeline } from "../../lib/step-map";
import {
  selectStreamedText,
  selectTerminalFailureEvent,
  useRunStore,
} from "../../stores/run-store";
import { ActivityTimeline } from "../timeline/ActivityTimeline";
import { FailureBanner } from "./FailureBanner";
import { MessageBubble } from "./MessageBubble";

/**
 * The live view attached to the turn currently driven by run-store: the
 * activity timeline, the streaming prose (until the assistant's persisted
 * reply shows up in the message list), and a failure banner for any
 * non-success terminal outcome (section 8: every failure state offers a
 * next action, never a dead end).
 */
export function RunTurn({
  hasAssistantReply,
  onRetry,
  onEdit,
}: {
  hasAssistantReply: boolean;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const events = useRunStore((s) => s.events);
  const receivedAt = useRunStore((s) => s.receivedAt);
  const outcome = useRunStore((s) => s.outcome);
  const runTerminal = outcome !== null && outcome !== "running";
  const rows = buildTimeline(events, receivedAt, runTerminal, outcome === "failed");
  const streamed = selectStreamedText(events);
  const failureEvent = selectTerminalFailureEvent(events);

  return (
    <div className="space-y-2">
      <ActivityTimeline rows={rows} />
      {!hasAssistantReply && streamed.length > 0 && (
        <MessageBubble role="assistant" content={streamed} />
      )}
      {!hasAssistantReply && streamed.length === 0 && outcome === "running" && (
        <div className="px-1 text-xs text-fg-muted">
          <span className="animate-pulse">Thinking…</span>
        </div>
      )}
      {failureEvent && <FailureBanner event={failureEvent} onRetry={onRetry} onEdit={onEdit} />}
    </div>
  );
}
