import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useCancelRun() {
  return useMutation({ mutationFn: (runId: string) => api.cancelRun(runId) });
}
