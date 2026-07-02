import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { applyOperations } from "../applier.js";
import { EMPTY_GRAPH } from "../types.js";
import type { Operation, WorkflowGraph, WorkflowNode } from "../types.js";

const NODE_ID_POOL = ["a", "b", "c", "d", "e"];

function makeNode(id: string): WorkflowNode {
  return { id, type: "slack.send_message", config: {}, position: { x: 0, y: 0 } };
}

const opArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  fc.constantFrom(...NODE_ID_POOL).map((id): Operation => ({ op: "add_node", node: makeNode(id) })),
  fc.constantFrom(...NODE_ID_POOL).map((id): Operation => ({ op: "remove_node", nodeId: id })),
);

describe("applyOperations (property)", () => {
  it("never throws, and the resulting node-id sequence matches a reference simulation, for any sequence of add_node/remove_node ops", () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { maxLength: 30 }), (ops) => {
        // Reference model: a plain array of ids mirroring the applier's
        // documented semantics — add_node always appends (duplicate ids are
        // legal), remove_node on a missing id is a no-op, remove_node on a
        // present id removes every node with that id (matching the
        // applier's `filter`, not a single-instance delete).
        let expectedIds: string[] = [];
        for (const op of ops) {
          if (op.op === "add_node") {
            expectedIds = [...expectedIds, op.node.id];
          } else if (op.op === "remove_node") {
            expectedIds = expectedIds.filter((id) => id !== op.nodeId);
          }
        }

        let result: WorkflowGraph | undefined;
        expect(() => {
          result = applyOperations(EMPTY_GRAPH, ops);
        }).not.toThrow();

        expect(result?.nodes.map((n) => n.id)).toEqual(expectedIds);
      }),
    );
  });
});
