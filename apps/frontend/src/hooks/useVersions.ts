import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useVersions(workflowId: string | null) {
  return useQuery({
    queryKey: ["versions", workflowId],
    queryFn: () => api.listVersions(workflowId as string),
    enabled: workflowId !== null,
  });
}

export function useDiff(workflowId: string | null, from: number | null, to: number | null) {
  return useQuery({
    queryKey: ["diff", workflowId, from, to],
    queryFn: () => api.getDiff(workflowId as string, from as number, to as number),
    enabled: workflowId !== null && from !== null && to !== null && from !== to,
  });
}

export function useRestoreVersion(workflowId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => api.restoreVersion(workflowId as string, version),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow", workflowId] });
      void queryClient.invalidateQueries({ queryKey: ["versions", workflowId] });
    },
  });
}
