import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useWorkflow(workflowId: string | null) {
  return useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => api.getWorkflow(workflowId as string),
    enabled: workflowId !== null,
  });
}
