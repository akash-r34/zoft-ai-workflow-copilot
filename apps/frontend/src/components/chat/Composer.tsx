"use client";

import { Send, Square } from "lucide-react";

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  isRunning,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: (content: string) => void;
  onStop: () => void;
  disabled: boolean;
  isRunning: boolean;
  hint?: string;
}) {
  function submit(): void {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    onChange("");
  }

  return (
    <div className="shrink-0 border-t border-border p-3">
      <div className="flex items-end gap-2">
        <textarea
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Describe the workflow you want…"
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-40 flex-1 resize-none rounded-xl border border-border bg-bg-elevated px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
        />
        {isRunning ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-danger text-white"
            aria-label="Stop generation"
            title="Stop (Esc)"
          >
            <Square className="h-3.5 w-3.5" fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg disabled:opacity-40"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
      {hint && <p className="mt-1.5 px-1 text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}
