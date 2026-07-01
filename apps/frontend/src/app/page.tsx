import type { WorkflowGraph } from "@zoft/contract";

// WorkflowGraph imported to confirm @zoft/contract is importable from frontend.
type _GraphCheck = WorkflowGraph;

export default function Home() {
  return (
    <main>
      <h1>Zoft AI Workflow Copilot</h1>
      <p>Scaffold ready. Phase 4 builds the UI.</p>
    </main>
  );
}
