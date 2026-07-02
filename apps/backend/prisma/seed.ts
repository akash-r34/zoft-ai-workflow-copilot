// Seeds the node catalog. Idempotent — safe to re-run: each entry is
// upserted keyed on `type`, so `pnpm --filter @zoft/backend db:seed` never
// duplicates rows.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface NodeSeed {
  type: string;
  category: "trigger" | "action";
  displayName: string;
  description: string;
  provider: string;
  configSchema: Record<string, unknown>;
  inputs: Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
}

const NODE_CATALOG: NodeSeed[] = [
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

async function main(): Promise<void> {
  for (const node of NODE_CATALOG) {
    await prisma.nodeDefinition.upsert({
      where: { type: node.type },
      create: node,
      update: node,
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    // eslint-disable-next-line no-console -- seed script, not a src/ production path
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
