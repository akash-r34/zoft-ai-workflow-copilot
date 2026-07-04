import { describe, expect, it } from "vitest";
import { deriveTitleFromMessage } from "../run-service.js";

describe("deriveTitleFromMessage", () => {
  it("uses the message verbatim when it's already short", () => {
    expect(deriveTitleFromMessage("send a slack message")).toBe("send a slack message");
  });

  it("trims surrounding whitespace and collapses internal whitespace/newlines", () => {
    expect(deriveTitleFromMessage("  send a   slack\nmessage  ")).toBe("send a slack message");
  });

  it("truncates a long message at the last word boundary and appends an ellipsis", () => {
    const long = "send a slack message whenever stripe receives a payment above five hundred dollars";
    const title = deriveTitleFromMessage(long);
    expect(title.length).toBeLessThanOrEqual(51); // 50 + ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(title.endsWith(" …")).toBe(false); // no trailing space before the ellipsis
    expect(long.startsWith(title.slice(0, -1))).toBe(true); // truncation, not paraphrase
  });

  it("hard-cuts a single very long word with no early word boundary", () => {
    const noSpaces = "a".repeat(80);
    const title = deriveTitleFromMessage(noSpaces);
    expect(title).toBe(`${"a".repeat(50)}…`);
  });

  it("does not truncate a message exactly at the limit", () => {
    const exact = "a".repeat(50);
    expect(deriveTitleFromMessage(exact)).toBe(exact);
  });

  it("truncates a message one character over the limit", () => {
    const overByOne = `${"word ".repeat(10)}x`; // 51 chars, has word boundaries throughout
    const title = deriveTitleFromMessage(overByOne);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThan(overByOne.length);
  });
});
