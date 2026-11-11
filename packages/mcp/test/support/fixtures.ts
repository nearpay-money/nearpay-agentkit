/** Spec-valid merchant objects (validated again by the spec mock on every response). */
import type { CheckoutSession, PaymentIntent, z } from "@nearpay-money/spec";

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const PI = "pi_01jbz9k3m4n5p6q7r8s9t0v1w5";
export const CS = "cs_01jbz9k3m4n5p6q7r8s9t0v1w2";

export function paymentIntent(over: Partial<z.input<typeof PaymentIntent>> = {}): z.input<typeof PaymentIntent> {
  return {
    id: PI,
    object: "payment_intent",
    created: 1_794_000_000,
    livemode: false,
    status: "succeeded",
    amount: "2000000",
    currency: "asset",
    asset_id: USDC,
    description: "Widget",
    source: "checkout",
    checkout_session: CS,
    destination: {
      settlement_destination: "sd_01jbz9k3m4n5p6q7r8s9t0v1w2",
      asset_id: USDC,
      type: "intents_account",
      chain: "near:mainnet",
      address: "merchant.near",
      fingerprint: "YZMN-R81Z-BR",
    },
    fee: { bearer: "payer", total_bps: 30 },
    settlement_asset_id: USDC,
    amount_settled: "2000000",
    amount_refunded: "0",
    succeeded_at: 1_794_000_100,
    late: false,
    canceled_at: null,
    cancellation_reason: null,
    review_reason: null,
    attempts: [],
    overpayments: [],
    sequence: 3,
    metadata: { order: "42" },
    customer: null,
    payment_link: null,
    amount_refund_pending: "0",
    refunds: [],
    review_decision: null,
    invoice: null,
    ...over,
  };
}

export function checkoutSession(over: Partial<z.input<typeof CheckoutSession>> = {}): z.input<typeof CheckoutSession> {
  return {
    id: CS,
    object: "checkout_session",
    created: 1_794_000_000,
    livemode: false,
    status: "open",
    url: `https://pay.nearpay.localhost/c/${CS}#${CS}_secret_${"a".repeat(32)}`,
    client_secret: `${CS}_secret_${"a".repeat(32)}`,
    expires_at: 1_794_003_600,
    payment_intent: PI,
    amount: "2000000",
    currency: "asset",
    asset_id: USDC,
    settlement_destination: "sd_01jbz9k3m4n5p6q7r8s9t0v1w2",
    ui_mode: "hosted",
    success_url: "https://merchant.example/thanks",
    cancel_url: null,
    description: "Widget",
    allowed_origins: [],
    late_payments: false,
    locale: null,
    completed_at: null,
    late: false,
    sequence: 0,
    metadata: {},
    customer: null,
    payment_link: null,
    invoice: null,
    ...over,
  };
}
