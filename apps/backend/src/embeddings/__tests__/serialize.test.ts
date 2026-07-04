import { describe, expect, it } from "vitest";
import { toVectorLiteral } from "../serialize.js";

describe("toVectorLiteral", () => {
  it("formats a number[] as a pgvector text literal", () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });

  it("handles an empty vector", () => {
    expect(toVectorLiteral([])).toBe("[]");
  });

  it("handles negative and zero values", () => {
    expect(toVectorLiteral([0, -1, 1])).toBe("[0,-1,1]");
  });
});
