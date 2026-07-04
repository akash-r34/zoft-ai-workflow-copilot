import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { applyVersion, restoreVersion } from "../version-applier.js";
import type { CatalogEntry, Operation, WorkflowGraph } from "../types.js";

const CATALOG: CatalogEntry[] = [
  {
    type: "stripe.payment_received",
    category: "trigger",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    inputs: [],
    outputs: [{ name: "payment", type: "stripe.Payment" }],
  },
  {
    type: "slack.send_message",
    category: "action",
    configSchema: {
      type: "object",
      required: ["channel", "text"],
      properties: { channel: { type: "string" }, text: { type: "string" } },
      additionalProperties: false,
    },
    inputs: [{ name: "trigger", type: "any" }],
    outputs: [],
  },
];

const VALID_OPS: Operation[] = [
  {
    op: "add_node",
    node: { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
  },
  {
    op: "add_node",
    node: {
      id: "a1",
      type: "slack.send_message",
      config: { channel: "#payments", text: "Payment received!" },
      position: { x: 200, y: 0 },
    },
  },
  { op: "add_edge", edge: { id: "e1", source: "t1", target: "a1" } },
];

// Two trigger nodes -> fails the TRIGGER_COUNT structural check.
const INVALID_OPS: Operation[] = [
  {
    op: "add_node",
    node: { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
  },
  {
    op: "add_node",
    node: { id: "t2", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
  },
];

interface FakeVersionRow {
  id: string;
  workflowId: string;
  version: number;
  graph: WorkflowGraph;
  createdBy: string;
  changeSummary: string;
  parentVersionId: string | null;
}

interface FakeWorkflowRow {
  id: string;
  currentVersionId: string | null;
}

// Declared explicitly (rather than inferred) because $transaction's callback
// parameter references this same shape — without an explicit annotation,
// TS cannot resolve the self-referential inference on the `db` object below.
interface FakeDb {
  workflow: {
    findUnique(args: {
      where: { id: string };
    }): Promise<(FakeWorkflowRow & { currentVersion: FakeVersionRow | null }) | null>;
    update(args: {
      where: { id: string };
      data: { currentVersionId: string };
    }): Promise<FakeWorkflowRow>;
  };
  workflowVersion: {
    aggregate(args: {
      where: { workflowId: string };
    }): Promise<{ _max: { version: number | null } }>;
    create(args: { data: Omit<FakeVersionRow, "id"> }): Promise<FakeVersionRow>;
    findUnique(args: {
      where: { workflowId_version: { workflowId: string; version: number } };
    }): Promise<FakeVersionRow | null>;
  };
  $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T>;
}

/**
 * A minimal in-memory stand-in for PrismaClient implementing only the
 * methods version-applier.ts actually calls (workflow.findUnique/update,
 * workflowVersion.aggregate/create, $transaction). $transaction just invokes
 * its callback against this same fake — sufficient to assert write counts
 * and outcomes without a real database.
 *
 * It is cast to PrismaClient at each call site below via
 * `db as unknown as PrismaClient`; that cast is safe because applyVersion's
 * implementation never calls any PrismaClient method beyond the ones
 * implemented here — this test file is what pins that invariant.
 */
function createFakePrisma(workflow: FakeWorkflowRow, versions: FakeVersionRow[] = []) {
  let nextId = 1;
  const createCalls: FakeVersionRow[] = [];
  const updateCalls: Array<{ id: string; currentVersionId: string }> = [];

  const db: FakeDb = {
    workflow: {
      findUnique: (args: { where: { id: string } }) => {
        if (args.where.id !== workflow.id) return Promise.resolve(null);
        const currentVersion = versions.find((v) => v.id === workflow.currentVersionId) ?? null;
        return Promise.resolve({ ...workflow, currentVersion });
      },
      update: (args: { where: { id: string }; data: { currentVersionId: string } }) => {
        workflow.currentVersionId = args.data.currentVersionId;
        updateCalls.push({ id: args.where.id, currentVersionId: args.data.currentVersionId });
        return Promise.resolve({ ...workflow });
      },
    },
    workflowVersion: {
      aggregate: (args: { where: { workflowId: string } }) => {
        const forWorkflow = versions.filter((v) => v.workflowId === args.where.workflowId);
        const max = forWorkflow.reduce((m, v) => Math.max(m, v.version), 0);
        return Promise.resolve({ _max: { version: forWorkflow.length === 0 ? null : max } });
      },
      create: (args: { data: Omit<FakeVersionRow, "id"> }) => {
        const row: FakeVersionRow = { id: `v${nextId++}`, ...args.data };
        versions.push(row);
        createCalls.push(row);
        return Promise.resolve(row);
      },
      findUnique: (args: {
        where: { workflowId_version: { workflowId: string; version: number } };
      }) => {
        const { workflowId, version } = args.where.workflowId_version;
        const found = versions.find((v) => v.workflowId === workflowId && v.version === version);
        return Promise.resolve(found ?? null);
      },
    },
    $transaction: <T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> => fn(db),
  };

  return { db, createCalls, updateCalls, versions, workflow };
}

describe("applyVersion", () => {
  it("starts from EMPTY_GRAPH and creates version 1 when currentVersionId is null", async () => {
    const { db, createCalls, updateCalls } = createFakePrisma({ id: "wf1", currentVersionId: null });

    const result = await applyVersion(
      db as unknown as PrismaClient,
      "wf1",
      VALID_OPS,
      CATALOG,
      "ai",
      "add a Stripe trigger and Slack action",
    );

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.version).toBe(1);
      expect(result.graph.nodes).toHaveLength(2);
    }
    expect(createCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toEqual({ id: "wf1", currentVersionId: "v1" });
  });

  it("increments the version number from the existing max version for the workflow", async () => {
    const existingGraph: WorkflowGraph = {
      nodes: [{ id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
    };
    const { db, createCalls } = createFakePrisma(
      { id: "wf1", currentVersionId: "v-existing" },
      [
        {
          id: "v-existing",
          workflowId: "wf1",
          version: 3,
          graph: existingGraph,
          createdBy: "user",
          changeSummary: "seed",
          parentVersionId: null,
        },
      ],
    );

    const result = await applyVersion(db as unknown as PrismaClient, "wf1", [], CATALOG, "ai", "no-op re-save");

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.version).toBe(4);
    }
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.parentVersionId).toBe("v-existing");
  });

  it("writes nothing and returns validation errors when the candidate graph is invalid", async () => {
    const { db, createCalls, updateCalls } = createFakePrisma({ id: "wf1", currentVersionId: null });

    const result = await applyVersion(db as unknown as PrismaClient, "wf1", INVALID_OPS, CATALOG, "ai", "two triggers");

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.some((e) => e.code === "TRIGGER_COUNT")).toBe(true);
    }
    expect(createCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("throws when the workflow does not exist", async () => {
    const { db } = createFakePrisma({ id: "wf1", currentVersionId: null });

    await expect(
      applyVersion(db as unknown as PrismaClient, "does-not-exist", VALID_OPS, CATALOG, "ai", "x"),
    ).rejects.toThrow(/not found/);
  });
});

describe("restoreVersion", () => {
  const graphV1: WorkflowGraph = {
    nodes: [{ id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } }],
    edges: [],
  };
  const graphV2: WorkflowGraph = {
    nodes: [
      { id: "t1", type: "stripe.payment_received", config: {}, position: { x: 0, y: 0 } },
      {
        id: "a1",
        type: "slack.send_message",
        config: { channel: "#payments", text: "hi" },
        position: { x: 200, y: 0 },
      },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };

  function seedTwoVersions() {
    return createFakePrisma({ id: "wf1", currentVersionId: "v2" }, [
      {
        id: "v1",
        workflowId: "wf1",
        version: 1,
        graph: graphV1,
        createdBy: "ai",
        changeSummary: "created",
        parentVersionId: null,
      },
      {
        id: "v2",
        workflowId: "wf1",
        version: 2,
        graph: graphV2,
        createdBy: "ai",
        changeSummary: "added slack",
        parentVersionId: "v1",
      },
    ]);
  }

  it("re-saves the target version's graph verbatim as a new version", async () => {
    const { db, createCalls, updateCalls } = seedTwoVersions();

    const result = await restoreVersion(db as unknown as PrismaClient, "wf1", 1, CATALOG);

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.version).toBe(3);
      expect(result.graph).toEqual(graphV1);
    }
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.changeSummary).toBe("Restored to version 1");
    expect(createCalls[0]?.createdBy).toBe("user");
    expect(createCalls[0]?.parentVersionId).toBe("v2"); // parent is whatever was current, not the restored version
    expect(updateCalls).toHaveLength(1);
    // The workflow's currentVersionId must repoint to the newly created row,
    // not to "v1" (the id of the version being restored FROM).
    expect(updateCalls[0]?.currentVersionId).toBe(createCalls[0]?.id);
  });

  it("writes nothing when the target graph fails re-validation against the current catalog", async () => {
    const { db, createCalls } = seedTwoVersions();
    // A catalog that no longer recognizes slack.send_message simulates a node
    // type being retired after v2 was created.
    const shrunkCatalog = CATALOG.filter((c) => c.type !== "slack.send_message");

    const result = await restoreVersion(db as unknown as PrismaClient, "wf1", 2, shrunkCatalog);

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.some((e) => e.code === "UNKNOWN_NODE_TYPE")).toBe(true);
    }
    expect(createCalls).toHaveLength(0);
  });

  it("throws when the target version does not exist", async () => {
    const { db } = seedTwoVersions();

    await expect(restoreVersion(db as unknown as PrismaClient, "wf1", 99, CATALOG)).rejects.toThrow(
      /not found/,
    );
  });

  it("throws when the workflow does not exist", async () => {
    const { db } = seedTwoVersions();

    await expect(
      restoreVersion(db as unknown as PrismaClient, "does-not-exist", 1, CATALOG),
    ).rejects.toThrow(/not found/);
  });
});
