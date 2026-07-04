"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { PanelLeft, PanelRightOpen } from "lucide-react";
import { useConversations, useCreateConversation } from "../hooks/useConversations";
import { useRunStream } from "../hooks/useRunStream";
import { ConversationList } from "./Sidebar/ConversationList";
import { ChatPane } from "./chat/ChatPane";
import { ConnectionBadge } from "./ui/ConnectionBadge";
import { ThemeToggle } from "./ui/ThemeToggle";
import { WorkflowPanel } from "./workflow/WorkflowPanel";

export function Workspace() {
  const { data: conversations } = useConversations();
  const createConversation = useCreateConversation();
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileView, setMobileView] = useState<"chat" | "workflow">("chat");
  // Guards against a duplicate create request from React StrictMode's
  // double-invoked effect in dev — isPending alone isn't synchronous enough
  // to prevent the second invocation from racing the first.
  const hasRequestedCreateRef = useRef(false);

  useEffect(() => {
    if (!conversations) return;
    if (conversations.length === 0) {
      if (!hasRequestedCreateRef.current) {
        hasRequestedCreateRef.current = true;
        createConversation.mutate(undefined);
      }
      return;
    }
    hasRequestedCreateRef.current = false;
    if (
      activeConversationId === null ||
      !conversations.some((c) => c.id === activeConversationId)
    ) {
      const first = conversations[0];
      if (first) setActiveConversationId(first.id);
    }
  }, [conversations, activeConversationId, createConversation]);

  const activeConversation = conversations?.find((c) => c.id === activeConversationId) ?? null;
  const workflowId = activeConversation?.workflowId ?? null;

  useRunStream(activeConversationId, workflowId);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setMobileView((v) => (v === "chat" ? "workflow" : "chat"));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden">
      {sidebarOpen && (
        <ConversationList
          conversations={conversations ?? []}
          activeId={activeConversationId}
          onSelect={setActiveConversationId}
          onCreate={() => {
            // mutateAsync (a plain promise) rather than mutate's per-call
            // onSuccess — the latter only fires if the mutation observer
            // still "hasListeners()" at resolution time, which is a race
            // for a request this fast against the local mock.
            createConversation
              .mutateAsync(undefined)
              .then((data) => setActiveConversationId(data.id))
              .catch(() => {});
          }}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-bg-sunken"
              aria-label="Toggle conversation list"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <span className="truncate text-sm font-semibold">
              {activeConversation?.title ?? "Zoft Copilot"}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ConnectionBadge />
            <ThemeToggle />
            <button
              type="button"
              onClick={() => setMobileView((v) => (v === "chat" ? "workflow" : "chat"))}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs md:hidden"
            >
              <PanelRightOpen className="h-3.5 w-3.5" />
              {mobileView === "chat" ? "Workflow" : "Chat"}
            </button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <div
            className={clsx(
              "min-w-0 flex-1",
              mobileView === "chat" ? "flex flex-col" : "hidden md:flex md:flex-col",
            )}
          >
            <ChatPane conversationId={activeConversationId} />
          </div>
          <div
            className={clsx(
              "w-full shrink-0 border-l border-border md:w-[420px]",
              mobileView === "workflow" ? "flex flex-col" : "hidden md:flex md:flex-col",
            )}
          >
            <WorkflowPanel workflowId={workflowId} />
          </div>
        </div>
      </div>
    </div>
  );
}
