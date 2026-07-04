// The node catalog, mirrored verbatim from apps/backend/prisma/seed.ts so the
// mock demonstrates the same five node types the real backend would seed.
// This is intentionally duplicated (not imported) — the mock is a standalone
// dev server with no dependency on the backend's Prisma setup.
import type { NodeDefinitionDto } from "@zoft/contract";

export const NODE_CATALOG: NodeDefinitionDto[] = [
  {
    type: "stripe.payment_received",
    category: "trigger",
    displayName: "Stripe: Payment Received",
    description: "Fires when Stripe receives a payment.",
    provider: "stripe",
    configSchema: {
      type: "object",
      properties: {
        currency: { type: "string", default: "usd" },
      },
      additionalProperties: false,
    },
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
      properties: {
        channel: { type: "string", description: "Slack channel, e.g. #payments" },
        text: { type: "string", description: "Message body" },
      },
      additionalProperties: false,
    },
    inputs: [{ name: "trigger", type: "any" }],
    outputs: [],
  },
  {
    type: "teams.send_message",
    category: "action",
    displayName: "Teams: Send Message",
    description: "Sends a message to a Microsoft Teams channel.",
    provider: "teams",
    configSchema: {
      type: "object",
      required: ["teamId", "channelId", "text"],
      properties: {
        teamId: { type: "string" },
        channelId: { type: "string" },
        text: { type: "string" },
      },
      additionalProperties: false,
    },
    inputs: [{ name: "trigger", type: "any" }],
    outputs: [],
  },
  {
    type: "filter.condition",
    category: "action",
    displayName: "Filter: Condition",
    description: "Passes through only when a field satisfies a condition.",
    provider: "filter",
    configSchema: {
      type: "object",
      required: ["field", "op", "value"],
      properties: {
        field: { type: "string", description: "e.g. amount" },
        op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte"] },
        value: {},
      },
      additionalProperties: false,
    },
    inputs: [{ name: "value", type: "any" }],
    outputs: [{ name: "passed", type: "any" }],
  },
  {
    type: "schedule.weekday_filter",
    category: "action",
    displayName: "Schedule: Weekday Filter",
    description: "Passes through only on the allowed days of the week.",
    provider: "schedule",
    configSchema: {
      type: "object",
      properties: {
        allowedDays: {
          type: "array",
          items: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
          default: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        },
      },
      additionalProperties: false,
    },
    inputs: [{ name: "trigger", type: "any" }],
    outputs: [{ name: "trigger", type: "any" }],
  },
];

export function findCatalogEntry(type: string): NodeDefinitionDto | undefined {
  return NODE_CATALOG.find((entry) => entry.type === type);
}

export function isTriggerType(type: string): boolean {
  return findCatalogEntry(type)?.category === "trigger";
}
