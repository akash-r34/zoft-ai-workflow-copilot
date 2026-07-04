"use client";

import { useEffect, useMemo, useState } from "react";
import type { SseEvent } from "@zoft/contract";
import { useCancelRun } from "../../hooks/useCancelRun";
import { useMessages } from "../../hooks/useMessages";
import { useSendMessage } from "../../hooks/useSendMessage";
import { useRunStore } from "../../stores/run-store";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

function runningHint(events: SseEvent[]): string | undefined {
  const last = events[events.length - 1];
  if (!last) return "Copilot is working…";
  if (last.event === "retry") return `Retrying (attempt ${last.data.attempt} of ${last.data.max})…`;
  if (last.event === "agent.step") return last.data.label;
  if (last.event === "tool.call") return `Running ${last.data.tool}…`;
  return "Copilot is working…";
}

export function ChatPane({ conversationId }: { conversationId: string | null }) {
  const { data: messages } = useMessages(conversationId);
  const { send, pending } = useSendMessage(conversationId);
  const cancelRun = useCancelRun();
  const outcome = useRunStore((s) => s.outcome);
  const events = useRunStore((s) => s.events);
  const runId = useRunStore((s) => s.runId);
  const runConversationId = useRunStore((s) => s.conversationId);
  // A run belongs to whichever conversation started it — a different
  // conversation's composer must not disable/show Stop for it.
  const runBelongsHere = runId !== null && runConversationId === conversationId;
  const isRunning = runBelongsHere && outcome === "running";
  const hint = isRunning ? runningHint(events) : undefined;
  const [draft, setDraft] = useState("");

  // The content that started the run currently attached to run-store — the
  // only thing a failure banner's Retry/Edit actions need to act on.
  const activeRunContent = useMemo(() => {
    if (!runBelongsHere || !messages) return null;
    return messages.find((m) => m.runId === runId && m.role === "user")?.content ?? null;
  }, [runBelongsHere, runId, messages]);

  function handleStop(): void {
    if (runBelongsHere && runId) cancelRun.mutate(runId);
  }

  function handleRetryRun(): void {
    if (activeRunContent) send(activeRunContent);
  }

  function handleEditRun(): void {
    if (activeRunContent) setDraft(activeRunContent);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape" && isRunning && runId) cancelRun.mutate(runId);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, runId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageList
        conversationId={conversationId}
        messages={messages ?? []}
        pending={pending}
        onRetryRun={handleRetryRun}
        onEditRun={handleEditRun}
      />
      <Composer
        value={draft}
        onChange={setDraft}
        onSend={send}
        onStop={handleStop}
        disabled={!conversationId || isRunning || pending !== null}
        isRunning={isRunning}
        {...(hint !== undefined ? { hint } : {})}
      />
    </div>
  );
}
