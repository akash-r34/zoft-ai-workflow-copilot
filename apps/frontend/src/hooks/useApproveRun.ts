// Approve/reject resolve the run over REST; the resulting workflow.updated
// (approve) or run.completed (reject) SSE event is what actually drives the
// cache invalidation — see useRunStream.ts. These hooks stay as thin as
// useCancelRun.ts on purpose.
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useApproveRun() {
  return useMutation({ mutationFn: (runId: string) => api.approveRun(runId) });
}

export function useRejectRun() {
  return useMutation({ mutationFn: (runId: string) => api.rejectRun(runId) });
}
