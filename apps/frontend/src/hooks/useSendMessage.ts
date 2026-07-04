// Optimistic send: the user's bubble appears immediately (local state, not
// the query cache — it's not a real MessageDto yet); if the run fails to
// start, the bubble gets a retry affordance instead of vanishing.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useRunStore } from "../stores/run-store";

export interface PendingMessage {
  content: string;
  status: "pending" | "error";
}

export function useSendMessage(conversationId: string | null) {
  const queryClient = useQueryClient();
  const startRun = useRunStore((s) => s.startRun);
  const [pending, setPending] = useState<PendingMessage | null>(null);

  const mutation = useMutation({
    mutationFn: async (content: string) => {
      if (!conversationId) throw new Error("no active conversation");
      return api.createRun(conversationId, content);
    },
    onMutate: (content: string) => {
      setPending({ content, status: "pending" });
    },
    onSuccess: (data) => {
      setPending(null);
      if (conversationId) startRun(data.runId, conversationId);
      void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      // The mock attaches a workflow to the conversation on its first run
      // (ensureWorkflow), so the conversation list's cached workflowId can be
      // stale the moment a run starts — refetch it so useWorkflow() picks up.
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: () => {
      setPending((prev) => (prev ? { ...prev, status: "error" } : prev));
    },
  });

  return {
    send: (content: string) => mutation.mutate(content),
    retry: () => {
      if (pending) mutation.mutate(pending.content);
    },
    dismiss: () => setPending(null),
    pending,
  };
}
