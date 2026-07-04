import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useMessages(conversationId: string | null) {
  return useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => api.listMessages(conversationId as string),
    enabled: conversationId !== null,
  });
}
