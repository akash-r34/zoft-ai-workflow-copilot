import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationDto } from "@zoft/contract";
import { api } from "../lib/api";

export function useConversations() {
  return useQuery({ queryKey: ["conversations"], queryFn: api.listConversations });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title?: string) => api.createConversation(title),
    onSuccess: (created) => {
      // Write straight into the cache instead of just invalidating: an
      // invalidate-triggered refetch is async, and a caller that immediately
      // selects the new conversation would otherwise race a "not in the
      // (stale) list yet" correction back to the previous selection.
      queryClient.setQueryData<ConversationDto[]>(["conversations"], (old) => [
        created,
        ...(old ?? []),
      ]);
    },
  });
}
