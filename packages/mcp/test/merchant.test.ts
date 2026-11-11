/** Merchant tools against the spec-validating mock (requests and responses checked against spec 0.3.0). */
import { createCheckoutSession, getPaymentIntent, listPaymentIntents } from "@nearpay-money/spec";
import { afterEach, describe, expect, it } from "vitest";
import { CS, checkoutSession, PI, paymentIntent, USDC } from "./support/fixtures.js";
import { harness } from "./support/harness.js";
import { MockApiError } from "./support/spec-mock.js";

let h: Awaited<ReturnType<typeof harness>>;
afterEach(async () => {
  expect(h.api.violations).toStrictEqual([]);
  await h.close();
});

describe("merchant tools", () => {
  it("lists merchant and payer tools with JSON schemas from the spec", async () => {
    h = await harness();
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toStrictEqual([
      "nearpay_create_checkout_session",
      "nearpay_fetch_paid",
      "nearpay_get_payment_intent",
      "nearpay_get_spending",
      "nearpay_list_payments",
      "nearpay_pay_checkout_session",
      "nearpay_resume_paid_fetch",
    ]);
    const create = tools.find((t) => t.name === "nearpay_create_checkout_session");
    expect(create?.inputSchema.properties).toHaveProperty("success_url");
    expect(create?.inputSchema.properties).toHaveProperty("idempotency_key");
    expect(tools.find((t) => t.name === "nearpay_pay_checkout_session")?.annotations?.destructiveHint).toBe(true);
  });

  it("creates a checkout session with an Idempotency-Key and returns its URL (not the bare client secret)", async () => {
    h = await harness();
    h.api.on(createCheckoutSession, (req) => checkoutSession({ amount: (req.body as { amount: string }).amount }));
    const r = await h.call("nearpay_create_checkout_session", {
      amount: "2000000",
      currency: "asset",
      asset_id: USDC,
      success_url: "https://merchant.example/thanks",
      idempotency_key: "order-42",
    });
    expect(r.isError).toBe(false);
    expect(r.data.checkout_session).toMatchObject({ id: CS, url: expect.stringContaining(`/c/${CS}#`) });
    expect(r.data.checkout_session).not.toHaveProperty("client_secret");
    expect(r.data.idempotency_key).toBe("order-42");
    expect(h.api.calls[0]?.idempotencyKey).toBe("order-42");
    expect(h.api.calls[0]?.headers.get("authorization")).toBe("Bearer sk_test_merchant000000000000000000");
  });

  it("retries a 503 with the same Idempotency-Key", async () => {
    h = await harness();
    h.api.once(createCheckoutSession, new Response(JSON.stringify({}), { status: 503 }));
    h.api.on(createCheckoutSession, () => checkoutSession());
    const r = await h.call("nearpay_create_checkout_session", {
      amount: 500,
      currency: "usd",
      success_url: "https://merchant.example/thanks",
    });
    expect(r.isError).toBe(false);
    const keys = h.api.attempts.map((a) => a.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  }, 10_000);

  it("refuses invalid arguments before calling the API (spec refinements apply)", async () => {
    h = await harness();
    const r = await h.call("nearpay_create_checkout_session", {
      amount: 500,
      currency: "asset",
      success_url: "https://merchant.example/thanks",
    });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("invalid_arguments");
    expect(h.api.calls).toHaveLength(0);
  });

  it("surfaces API errors with their code", async () => {
    h = await harness();
    h.api.on(createCheckoutSession, () => {
      throw new MockApiError("account_not_live");
    });
    const r = await h.call("nearpay_create_checkout_session", {
      amount: "1",
      currency: "asset",
      asset_id: USDC,
      success_url: "https://merchant.example/thanks",
    });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: "api_error", details: { api_code: "account_not_live" } });
  });

  it("gets a payment intent", async () => {
    h = await harness();
    h.api.on(getPaymentIntent, (req) => paymentIntent({ id: req.params.id as never }));
    const r = await h.call("nearpay_get_payment_intent", { id: PI });
    expect(r.data.payment_intent).toMatchObject({ id: PI, status: "succeeded", amount_settled: "2000000" });
    const bad = await h.call("nearpay_get_payment_intent", { id: "pi_x" });
    expect(bad.isError).toBe(true);
  });

  it("lists payments with typed filters, metadata and a next cursor", async () => {
    h = await harness();
    h.api.on(listPaymentIntents, () => ({
      object: "list",
      data: [paymentIntent()],
      has_more: true,
      url: "/v1/payment_intents",
    }));
    const r = await h.call("nearpay_list_payments", {
      limit: 1,
      status: "succeeded",
      "created[gte]": 1_794_000_000,
      metadata: { order: "42" },
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ has_more: true, next_starting_after: PI });
    expect(h.api.calls[0]?.query).toMatchObject({
      limit: 1,
      status: "succeeded",
      "created[gte]": 1_794_000_000,
      "metadata[order]": "42",
    });
  });

  it("registers no merchant tools without a merchant key, and no payer tools without a payer", async () => {
    h = await harness({ options: ({ merchantApiKey: _k, ...o }) => o });
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("nearpay_create_checkout_session");
    await h.close();
    h = await harness({ options: ({ payer: _p, ...o }) => o });
    expect((await h.client.listTools()).tools.map((t) => t.name)).toStrictEqual([
      "nearpay_create_checkout_session",
      "nearpay_get_payment_intent",
      "nearpay_list_payments",
    ]);
  });
});
