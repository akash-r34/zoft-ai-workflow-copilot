"use client";

import { Fragment } from "react";
import type { MessageDto } from "@zoft/contract";
import type { PendingMessage } from "../../hooks/useSendMessage";
import { useRunStore } from "../../stores/run-store";
import { MessageBubble } from "./MessageBubble";
import { RunTurn } from "./RunTurn";

export function MessageList({
  conversationId,
  messages,
  pending,
  onRetryRun,
  onEditRun,
}: {
  conversationId: string | null;
  messages: MessageDto[];
  pending: PendingMessage | null;
  onRetryRun: () => void;
  onEditRun: () => void;
}) {
  const activeRunId = useRunStore((s) => s.runId);
  const activeRunConversationId = useRunStore((s) => s.conversationId);
  // A run belongs to whichever conversation started it — don't let it leak
  // into a different conversation the user has since switched to.
  const runBelongsHere = activeRunConversationId === conversationId;
  const hasActiveRunInList = activeRunId !== null && messages.some((m) => m.runId === activeRunId);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {messages.length === 0 && !pending && (activeRunId === null || !runBelongsHere) && (
        <p className="m-auto max-w-sm text-center text-sm text-fg-muted">
          Describe the workflow you want — for example, &quot;send a Slack message whenever Stripe
          receives a payment.&quot;
        </p>
      )}

      {messages.map((msg, i) => {
        const isLastForRun =
          msg.runId !== null && !messages.slice(i + 1).some((m) => m.runId === msg.runId);
        const showRunTurn = isLastForRun && msg.runId === activeRunId;
        return (
          <Fragment key={msg.id}>
            <MessageBubble role={msg.role} content={msg.content} />
            {showRunTurn && (
              <RunTurn
                hasAssistantReply={messages.some(
                  (m) => m.runId === activeRunId && m.role === "assistant",
                )}
                onRetry={onRetryRun}
                onEdit={onEditRun}
              />
            )}
          </Fragment>
        );
      })}

      {pending && <MessageBubble role="user" content={pending.content} tone={pending.status} />}

      {activeRunId !== null && runBelongsHere && !hasActiveRunInList && (
        <RunTurn hasAssistantReply={false} onRetry={onRetryRun} onEdit={onEditRun} />
      )}
    </div>
  );
}
