"use client";

import clsx from "clsx";
import { Plus } from "lucide-react";
import type { ConversationDto } from "@zoft/contract";

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onCreate,
}: {
  conversations: ConversationDto[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-bg-sunken">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="text-sm font-semibold">Conversations</span>
        <button
          type="button"
          onClick={onCreate}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-border hover:bg-bg-elevated"
          aria-label="New conversation"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-fg-muted">No conversations yet.</p>
        )}
        {conversations.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={clsx(
              "block w-full truncate rounded-lg px-2.5 py-2 text-left text-sm",
              c.id === activeId ? "bg-accent text-accent-fg" : "hover:bg-bg-elevated",
            )}
          >
            {c.title}
          </button>
        ))}
      </div>
    </aside>
  );
}
