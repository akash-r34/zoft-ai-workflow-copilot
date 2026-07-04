import { describe, expect, it } from "vitest";
import type { NodeDefinitionDto } from "@zoft/contract";
import { findCatalogEntry, isTriggerType, searchCatalog, toCatalogEntries } from "../catalog-service.js";

const FIXTURE: NodeDefinitionDto[] = [
  {
    type: "stripe.payment_received",
    category: "trigger",
    displayName: "Stripe: Payment Received",
    description: "Fires when Stripe receives a payment.",
    provider: "stripe",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    inputs: [],
    outputs: [{ name: "payment", type: "stripe.Payment" }],
  },
  {
    type: "slack.send_message",
    category: "action",
    displayName: "Slack: Send Message",
    description: "Sends a message to a Slack channel.",
    provider: "slack",
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

describe("searchCatalog", () => {
  it("returns the full catalog when no query is given", () => {
    expect(searchCatalog(FIXTURE)).toHaveLength(2);
    expect(searchCatalog(FIXTURE, "")).toHaveLength(2);
    expect(searchCatalog(FIXTURE, "   ")).toHaveLength(2);
  });

  it("matches by type, displayName, provider, or description (case-insensitive)", () => {
    expect(searchCatalog(FIXTURE, "STRIPE").map((n) => n.type)).toEqual(["stripe.payment_received"]);
    expect(searchCatalog(FIXTURE, "send message").map((n) => n.type)).toEqual(["slack.send_message"]);
    // "channel" legitimately matches Slack's description ("...Slack channel.")
    expect(searchCatalog(FIXTURE, "channel").map((n) => n.type)).toEqual(["slack.send_message"]);
    expect(searchCatalog(FIXTURE, "no-such-thing")).toEqual([]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(searchCatalog(FIXTURE, "nonexistent-provider")).toHaveLength(0);
  });
});

describe("findCatalogEntry / isTriggerType", () => {
  it("finds an entry by exact type", () => {
    expect(findCatalogEntry(FIXTURE, "slack.send_message")?.displayName).toBe("Slack: Send Message");
    expect(findCatalogEntry(FIXTURE, "unknown.type")).toBeUndefined();
  });

  it("identifies trigger vs. action categories", () => {
    expect(isTriggerType(FIXTURE, "stripe.payment_received")).toBe(true);
    expect(isTriggerType(FIXTURE, "slack.send_message")).toBe(false);
    expect(isTriggerType(FIXTURE, "unknown.type")).toBe(false);
  });
});

describe("toCatalogEntries", () => {
  it("projects NodeDefinitionDto[] down to the validator's CatalogEntry shape", () => {
    const entries = toCatalogEntries(FIXTURE);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      type: "stripe.payment_received",
      category: "trigger",
      configSchema: FIXTURE[0]?.configSchema,
      inputs: FIXTURE[0]?.inputs,
      outputs: FIXTURE[0]?.outputs,
    });
    // Fields that only exist on NodeDefinitionDto must not leak through.
    expect(entries[0]).not.toHaveProperty("displayName");
    expect(entries[0]).not.toHaveProperty("description");
  });
});
