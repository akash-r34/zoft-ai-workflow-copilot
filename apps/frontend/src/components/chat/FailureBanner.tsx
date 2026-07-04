// Section 8 of 03-frontend.md: "no dead ends" — every failure state renders
// here with at least one next action. The mock never partially commits (the
// prior version is always intact), so "Resume from draft" and "Retry" both
// currently just resend the original request; a real backend that preserved
// an actual uncommitted draft could make Resume skip straight to it.
import type { ReactNode } from "react";
import { AlertTriangle, Clock, OctagonX } from "lucide-react";
import type { SseEvent } from "@zoft/contract";

type FailureEvent = Extract<SseEvent, { event: "run.failed" | "run.timeout" | "run.cancelled" }>;

function ActionButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-xs font-medium hover:bg-bg-sunken"
    >
      {children}
    </button>
  );
}

function Banner({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: typeof AlertTriangle;
  tone: "warning" | "danger" | "muted";
  title: string;
  children?: ReactNode;
}) {
  const toneClass =
    tone === "danger"
      ? "border-danger/40 bg-danger/5"
      : tone === "warning"
        ? "border-warning/40 bg-warning/5"
        : "border-border bg-bg-sunken";
  const iconClass =
    tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-fg-muted";

  return (
    <div className={`rounded-xl border px-3.5 py-3 text-sm ${toneClass}`}>
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconClass}`} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium">{title}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function FailureBanner({
  event,
  onRetry,
  onEdit,
}: {
  event: FailureEvent;
  onRetry: () => void;
  onEdit: () => void;
}) {
  if (event.event === "run.timeout") {
    return (
      <Banner icon={Clock} tone="warning" title="The Copilot took too long.">
        <div className="flex gap-2">
          <ActionButton onClick={onRetry}>Retry</ActionButton>
          {event.data.draftAvailable && (
            <ActionButton onClick={onRetry}>Resume from draft</ActionButton>
          )}
        </div>
      </Banner>
    );
  }

  if (event.event === "run.failed") {
    return (
      <Banner icon={AlertTriangle} tone="danger" title={event.data.error.message}>
        <p className="text-xs text-fg-muted">
          The previous version was kept — nothing invalid was saved.
        </p>
        <div className="flex gap-2">
          <ActionButton onClick={onEdit}>Edit and try again</ActionButton>
          <ActionButton onClick={onRetry}>Retry as-is</ActionButton>
        </div>
      </Banner>
    );
  }

  return (
    <Banner icon={OctagonX} tone="muted" title="Run stopped.">
      <ActionButton onClick={onRetry}>Try again</ActionButton>
    </Banner>
  );
}
