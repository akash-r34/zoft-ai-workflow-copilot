// POST /api/dev/simulate/stripe-payment — a dev-only stub for demoing the
// Stripe trigger without a real Stripe account. Matches
// apps/frontend/mock/server.ts's stub; the real backend doesn't yet act on
// this beyond acknowledging receipt (no webhook-driven run trigger exists —
// see REMAINING.md).
import type { FastifyInstance } from "fastify";
import { SimulateStripePaymentBodySchema } from "@zoft/contract";

export function registerDevRoutes(app: FastifyInstance): void {
  app.post("/api/dev/simulate/stripe-payment", (request) => {
    const body = SimulateStripePaymentBodySchema.parse(request.body);
    return { received: true, amount: body.amount, currency: body.currency };
  });
}
