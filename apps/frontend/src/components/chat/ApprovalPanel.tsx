"use client";

// PRD v1.1 Decision #1: a human approval step between validation and the
// version applier is mandatory. This renders once the run emits
// workflow.proposed (see run-store.ts's selectPendingProposal) and
// disappears once the run reaches any terminal outcome — approve writes a
// new version (workflow.updated fires, RunTurn/WorkflowPanel pick it up via
// useRunStream's cache invalidation); reject discards it and the assistant's
// "Change discarded" message shows up the same way. Never a dead end: the
// panel always offers both actions until one is taken.
import { Check, X } from "lucide-react";
import type { SseEvent } from "@zoft/contract";
import { DiffView } from "../workflow/DiffView";

type Proposal = Extract<SseEvent, { event: "workflow.proposed" }>["data"];

export function ApprovalPanel({
  proposal,
  onApprove,
  onReject,
  isResolving,
}: {
  proposal: Proposal;
  onApprove: () => void;
  onReject: () => void;
  isResolving: boolean;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 px-3.5 py-3 text-sm">
      <div>
        <p className="font-medium">Review proposed change</p>
        <p className="text-xs text-fg-muted">{proposal.summary}</p>
      </div>
      <DiffView diff={proposal.diff} />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={isResolving}
          onClick={onApprove}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          Approve
        </button>
        <button
          type="button"
          disabled={isResolving}
          onClick={onReject}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-xs font-medium hover:bg-bg-sunken disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          Reject
        </button>
      </div>
    </div>
  );
}
