import type { WorkflowDiff } from "@zoft/contract";

// Accepts the plain WorkflowDiff shape (added/removed/changed) rather than
// the REST-only WorkflowDiffDto (which adds from/to version numbers) — this
// component never renders those, and the workflow.proposed SSE event carries
// a WorkflowDiff, not a WorkflowDiffDto. A WorkflowDiffDto still satisfies
// this prop structurally, so VersionHistory's existing usage is unaffected.
export function DiffView({ diff }: { diff: WorkflowDiff }) {
  const hasChanges =
    diff.added.nodes.length > 0 ||
    diff.removed.nodes.length > 0 ||
    diff.changed.length > 0 ||
    diff.added.edges.length > 0 ||
    diff.removed.edges.length > 0;

  if (!hasChanges) {
    return <p className="text-xs text-fg-muted">No differences from the current version.</p>;
  }

  return (
    <div className="space-y-1 text-xs">
      {diff.added.nodes.map((n) => (
        <div key={n.id} className="flex items-center gap-1.5 text-success">
          <span className="font-mono">+</span>
          <span className="truncate">{n.type}</span>
        </div>
      ))}
      {diff.removed.nodes.map((n) => (
        <div key={n.id} className="flex items-center gap-1.5 text-danger">
          <span className="font-mono">−</span>
          <span className="truncate">{n.type}</span>
        </div>
      ))}
      {diff.changed.map((c) => (
        <div key={c.id} className="flex items-center gap-1.5 text-warning">
          <span className="font-mono">~</span>
          <span className="truncate">{c.after.type} configuration changed</span>
        </div>
      ))}
    </div>
  );
}
