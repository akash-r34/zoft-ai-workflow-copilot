// The mock's single in-memory store: conversations, messages, workflows,
// workflow versions, runs, and the durable per-run SSE event log. Every
// mutation is persisted to disk (see persistence.ts) so a restarted mock
// resumes exactly where it left off — the same guarantee Postgres gives the
// real backend's run_event table.
import { randomUUID } from "node:crypto";
import type { NodeDefinitionDto, SseEvent, WorkflowDiffDto, WorkflowGraph } from "@zoft/contract";
import { NODE_CATALOG } from "./catalog.js";
import { cloneGraph, diffGraphs, toWorkflowDiffDto } from "./graph-ops.js";
import { loadSnapshot, saveSnapshot } from "./persistence.js";
import type {
  RunStatus,
  StoreSnapshot,
  StoredConversation,
  StoredMessage,
  StoredRun,
  StoredWorkflow,
  StoredWorkflowVersion,
} from "./types.js";

// Distributes Omit<_, "seq"> over the SseEvent union so authoring an event
// still requires the correct `data` shape for its `event` discriminant —
// a plain `Omit<SseEvent, "seq">` would collapse the union and lose that.
type OmitSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
export type SseEventInput = OmitSeq<SseEvent>;

function emptySnapshot(): StoreSnapshot {
  return {
    conversations: {},
    messages: {},
    workflows: {},
    workflowVersions: {},
    runs: {},
    runEvents: {},
  };
}

const snapshot: StoreSnapshot = loadSnapshot<StoreSnapshot>() ?? emptySnapshot();

function persist(): void {
  saveSnapshot(snapshot);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return randomUUID();
}

// ── Conversations ─────────────────────────────────────────────────────────
export function createConversation(title?: string): StoredConversation {
  const now = nowIso();
  const conversation: StoredConversation = {
    id: newId(),
    title: title && title.trim().length > 0 ? title.trim() : "New conversation",
    workflowId: null,
    createdAt: now,
    updatedAt: now,
  };
  snapshot.conversations[conversation.id] = conversation;
  persist();
  return conversation;
}

export function listConversations(): StoredConversation[] {
  return Object.values(snapshot.conversations).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function getConversation(id: string): StoredConversation | undefined {
  return snapshot.conversations[id];
}

// ── Messages ──────────────────────────────────────────────────────────────
export function listMessages(conversationId: string): StoredMessage[] {
  return Object.values(snapshot.messages)
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function addMessage(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  runId: string | null;
}): StoredMessage {
  const message: StoredMessage = {
    id: newId(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    runId: input.runId,
    createdAt: nowIso(),
  };
  snapshot.messages[message.id] = message;
  const conversation = snapshot.conversations[input.conversationId];
  if (conversation) conversation.updatedAt = nowIso();
  persist();
  return message;
}

// ── Workflows & versions ──────────────────────────────────────────────────
export function ensureWorkflow(conversationId: string): StoredWorkflow {
  const conversation = snapshot.conversations[conversationId];
  if (!conversation) throw new Error(`conversation ${conversationId} not found`);
  if (conversation.workflowId) {
    const existing = snapshot.workflows[conversation.workflowId];
    if (existing) return existing;
  }
  const workflow: StoredWorkflow = {
    id: newId(),
    name: "Untitled workflow",
    currentVersionId: null,
  };
  snapshot.workflows[workflow.id] = workflow;
  conversation.workflowId = workflow.id;
  conversation.updatedAt = nowIso();
  persist();
  return workflow;
}

export function getWorkflow(id: string): StoredWorkflow | undefined {
  return snapshot.workflows[id];
}

export function getCurrentVersion(workflowId: string): StoredWorkflowVersion | undefined {
  const workflow = snapshot.workflows[workflowId];
  if (!workflow?.currentVersionId) return undefined;
  return snapshot.workflowVersions[workflow.currentVersionId];
}

export function listVersions(workflowId: string): StoredWorkflowVersion[] {
  return Object.values(snapshot.workflowVersions)
    .filter((v) => v.workflowId === workflowId)
    .sort((a, b) => b.version - a.version);
}

export function getVersionByNumber(
  workflowId: string,
  version: number,
): StoredWorkflowVersion | undefined {
  return listVersions(workflowId).find((v) => v.version === version);
}

export function appendVersion(
  workflowId: string,
  graph: WorkflowGraph,
  createdBy: "user" | "ai",
  changeSummary: string,
): StoredWorkflowVersion {
  const workflow = snapshot.workflows[workflowId];
  if (!workflow) throw new Error(`workflow ${workflowId} not found`);
  const latest = listVersions(workflowId)[0];
  const version: StoredWorkflowVersion = {
    id: newId(),
    workflowId,
    version: (latest?.version ?? 0) + 1,
    graph: cloneGraph(graph),
    createdBy,
    changeSummary,
    parentVersionId: workflow.currentVersionId,
    createdAt: nowIso(),
  };
  snapshot.workflowVersions[version.id] = version;
  workflow.currentVersionId = version.id;
  persist();
  return version;
}

export function restoreVersion(
  workflowId: string,
  targetVersion: number,
): StoredWorkflowVersion | undefined {
  const target = getVersionByNumber(workflowId, targetVersion);
  if (!target) return undefined;
  return appendVersion(workflowId, target.graph, "user", `Restored to version ${targetVersion}`);
}

export function diffVersions(
  workflowId: string,
  from: number,
  to: number,
): WorkflowDiffDto | undefined {
  const fromVersion = getVersionByNumber(workflowId, from);
  const toVersion = getVersionByNumber(workflowId, to);
  if (!fromVersion || !toVersion) return undefined;
  return toWorkflowDiffDto(from, to, diffGraphs(fromVersion.graph, toVersion.graph));
}

// ── Runs ──────────────────────────────────────────────────────────────────
export function createRun(conversationId: string, workflowId: string): StoredRun {
  const run: StoredRun = {
    id: newId(),
    conversationId,
    workflowId,
    status: "pending",
    cancelRequested: false,
    createdAt: nowIso(),
  };
  snapshot.runs[run.id] = run;
  persist();
  return run;
}

export function getRun(id: string): StoredRun | undefined {
  return snapshot.runs[id];
}

export function setRunStatus(id: string, status: RunStatus): void {
  const run = snapshot.runs[id];
  if (!run) return;
  run.status = status;
  persist();
}

export function requestCancel(id: string): StoredRun | undefined {
  const run = snapshot.runs[id];
  if (!run) return undefined;
  run.cancelRequested = true;
  persist();
  return run;
}

export function isCancelRequested(id: string): boolean {
  return snapshot.runs[id]?.cancelRequested ?? false;
}

// ── Run events (the durable SSE log) ─────────────────────────────────────
function getOrCreateEventsArray(runId: string): SseEvent[] {
  const existing = snapshot.runEvents[runId];
  if (existing) return existing;
  const created: SseEvent[] = [];
  snapshot.runEvents[runId] = created;
  return created;
}

export function appendEvent(runId: string, input: SseEventInput): SseEvent {
  const events = getOrCreateEventsArray(runId);
  const seq = events.length + 1;
  // Safe by construction: `input` is exactly SseEvent minus `seq`; adding
  // `seq` back reconstructs a valid discriminated-union member.
  const full = { ...input, seq } as SseEvent;
  events.push(full);
  persist();
  notify(runId, full);
  return full;
}

export function getEventsSince(runId: string, sinceSeq: number): SseEvent[] {
  const events = snapshot.runEvents[runId] ?? [];
  return events.filter((e) => e.seq > sinceSeq);
}

const subscribers = new Map<string, Set<(evt: SseEvent) => void>>();

export function subscribe(runId: string, listener: (evt: SseEvent) => void): () => void {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

function notify(runId: string, evt: SseEvent): void {
  const set = subscribers.get(runId);
  if (!set) return;
  for (const listener of set) listener(evt);
}

// ── Node catalog ──────────────────────────────────────────────────────────
export function getNodeDefinitions(query?: string): NodeDefinitionDto[] {
  if (!query || query.trim().length === 0) return NODE_CATALOG;
  const q = query.toLowerCase();
  return NODE_CATALOG.filter(
    (n) =>
      n.type.toLowerCase().includes(q) ||
      n.displayName.toLowerCase().includes(q) ||
      n.provider.toLowerCase().includes(q) ||
      n.description.toLowerCase().includes(q),
  );
}
