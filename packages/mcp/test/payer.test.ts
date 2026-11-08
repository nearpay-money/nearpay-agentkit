/** Payer tools end to end: checkout and invoice payments, x402 (intents-transfer and near-intents), limits. */
import { type DepositRequest, memoryOperationStore, type OriginSigner } from "@nearpay/x402";
import { afterEach, describe, expect, it } from "vitest";
import { INVOICE, INVOICE_SECRET, SECRET, SESSION } from "../../agent-signer/test/fake-api.js";
import { BASE_USDC, ORIGINS, REFUND_TO } from "../../x402/test/fake-facilitator.js";
import { USDC } from "./support/fixtures.js";
import { harness } from "./support/harness.js";

const checkoutUrl = `https://pay.nearpay.localhost/c/${SESSION}#${SECRET}`;
const invoiceUrl = `https://pay.nearpay.localhost/i/${INVOICE}#${INVOICE_SECRET}`;
const TX = `0x${"ab".repeat(32)}`;

let h: Awaited<ReturnType<typeof harness>>;
afterEach(async () => {
  expect(h.api.violations).toStrictEqual([]);
  await h.close();
});

const limits = (perCall: Record<string, string>, perSession: Record<string, string>) => ({ perCall, perSession });

function origin() {
  const deposits: DepositRequest[] = [];
  const originSigner: OriginSigner = {
    canPay: (n, a) => Object.values(ORIGINS).some((o) => o.network === n && o.asset === a),
    refundTo: () => REFUND_TO,
    deposit: async (d) => {
      deposits.push(d);
      return { txHash: TX };
    },
  };
  return { originSigner, deposits };
}

describe("nearpay_pay_checkout_session", () => {
  it("pays a checkout session after sentinel verification and returns status, merchant and evidence", async () => {
    h = await harness({
      checkout: { intentStatuses: ["succeeded"] },
      options: (o) => ({
        ...o,
        payer: {
          ...(o.payer as NonNullable<typeof o.payer>),
          limits: limits({ [USDC]: "3000000" }, { [USDC]: "3000000" }),
        },
      }),
    });
    const r = await h.call("nearpay_pay_checkout_session", { url: checkoutUrl, wait_seconds: 5 });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      status: "succeeded",
      final: true,
      livemode: false,
      merchant: { name: "Demo Shop", pay_to: "merchant.near", destination_fingerprint: "YZMN-R81Z-BR" },
      payment: { asset: USDC, amount: "2000000", fee: "6000", total: "2006000" },
      checkout_session: { id: SESSION, intent_status: "succeeded" },
      budget: { asset: USDC, spent: "2006000" },
    });
    expect(r.data.evidence.map((e: { kind: string }) => e.kind)).toStrictEqual([
      "agent_payment",
      "checkout_session",
      "payment_intent",
      "attestation",
    ]);
    expect(h.checkout.submitted).toHaveLength(1);
    expect(r.text).not.toContain(SECRET);
  });

  it("pays a hosted invoice URL through its checkout session", async () => {
    h = await harness({
      options: (o) => ({
        ...o,
        payer: {
          ...(o.payer as NonNullable<typeof o.payer>),
          limits: limits({ [USDC]: "3000000" }, { [USDC]: "3000000" }),
        },
      }),
    });
    const r = await h.call("nearpay_pay_checkout_session", { url: invoiceUrl });
    expect(r.isError).toBe(false);
    expect(r.data.invoice).toMatchObject({ id: INVOICE, number: "DEMO-0001" });
    expect(r.data.status).toBe("submitted");
    expect(h.checkout.calls.slice(0, 2)).toStrictEqual([
      `GET /v1/invoices/${INVOICE}/public`,
      `POST /v1/invoices/${INVOICE}/public/sessions`,
    ]);
    expect(r.text).not.toContain(INVOICE_SECRET);
  });

  it("refuses URLs of other hosts and non-https URLs", async () => {
    h = await harness();
    const other = await h.call("nearpay_pay_checkout_session", { url: `https://evil.example/c/${SESSION}#${SECRET}` });
    expect(other.data.error.code).toBe("payment_host_not_allowed");
    const http = await h.call("nearpay_pay_checkout_session", {
      url: `http://pay.nearpay.localhost/c/${SESSION}#${SECRET}`,
    });
    expect(http.data.error.code).toBe("invalid_arguments");
    expect((await h.call("nearpay_pay_checkout_session", { url: "nope" })).data.error.code).toBe("invalid_arguments");
    expect(h.checkout.calls).toHaveLength(0);
    // refusal messages never echo the secret
    expect(other.text).not.toContain(SECRET);
  });

  it("refuses merchants outside the allow-list before anything is signed", async () => {
    h = await harness({
      options: (o) => ({ ...o, payer: { ...(o.payer as NonNullable<typeof o.payer>), allowedPayTo: ["other.near"] } }),
    });
    const r = await h.call("nearpay_pay_checkout_session", { url: checkoutUrl });
    expect(r.data.error.code).toBe("pay_to_not_allowed");
    expect(h.checkout.submitted).toHaveLength(0);
    expect(h.checkout.calls).not.toContain("POST /v1/attestations/deposit_instructions");
  });

  it("applies the default limits (1.00 USDC per call): a 2.006 USDC payment is refused", async () => {
    h = await harness();
    const r = await h.call("nearpay_pay_checkout_session", { url: checkoutUrl });
    expect(r.data.error.code).toBe("spend_limit_exceeded");
    expect(h.checkout.submitted).toHaveLength(0);
  });

  it("max_amount lowers the per-call limit; the session budget spans calls", async () => {
    h = await harness({
      options: (o) => ({
        ...o,
        payer: {
          ...(o.payer as NonNullable<typeof o.payer>),
          limits: limits({ [USDC]: "5000000" }, { [USDC]: "5000000" }),
        },
      }),
    });
    expect(
      (await h.call("nearpay_pay_checkout_session", { url: checkoutUrl, max_amount: "2005999" })).data.error.code,
    ).toBe("spend_limit_exceeded");
    expect((await h.call("nearpay_pay_checkout_session", { url: checkoutUrl })).isError).toBe(false);
    expect((await h.call("nearpay_pay_checkout_session", { url: checkoutUrl })).isError).toBe(false);
    const third = await h.call("nearpay_pay_checkout_session", { url: checkoutUrl });
    expect(third.data.error).toMatchObject({ code: "spend_limit_exceeded" });
    expect(third.data.error.message).toContain("session limit");
    expect(h.checkout.submitted).toHaveLength(2);
    const s = await h.call("nearpay_get_spending");
    expect(s.data.limits.find((l: { asset: string }) => l.asset === USDC)).toMatchObject({
      spent: "4012000",
      remaining: "988000",
    });
  });

  it("gives the budget back when agentpay refuses (4xx) and keeps it when the outcome is unknown (5xx)", async () => {
    const big = (o: Parameters<NonNullable<Parameters<typeof harness>[0]>["options"] & object>[0]) => ({
      ...o,
      payer: {
        ...(o.payer as NonNullable<typeof o.payer>),
        limits: limits({ [USDC]: "5000000" }, { [USDC]: "5000000" }),
      },
    });
    h = await harness({ checkout: { agentPayStatus: 400 }, options: big });
    expect((await h.call("nearpay_pay_checkout_session", { url: checkoutUrl })).data.error.details).toMatchObject({
      status: 400,
    });
    expect((await h.call("nearpay_get_spending")).data.limits[0]).toMatchObject({ spent: "0", reserved: "0" });
    await h.close();
    h = await harness({ checkout: { agentPayStatus: 503 }, options: big });
    await h.call("nearpay_pay_checkout_session", { url: checkoutUrl });
    expect(
      (await h.call("nearpay_get_spending")).data.limits.find((l: { asset: string }) => l.asset === USDC),
    ).toMatchObject({ spent: "2006000" });
  });

  it("refuses checkout payments without pinned sentinel keys", async () => {
    h = await harness({
      options: (o) => ({ ...o, payer: { ...(o.payer as NonNullable<typeof o.payer>), pinnedKeys: [] } }),
    });
    expect((await h.call("nearpay_pay_checkout_session", { url: checkoutUrl })).data.error.code).toBe("no_pinned_keys");
  });
});

describe("nearpay_fetch_paid", () => {
  it("pays an x402 resource from the Intents balance and returns the body and settlement evidence", async () => {
    h = await harness();
    const r = await h.call("nearpay_fetch_paid", { url: "https://merchant.test/premium" });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      status: 200,
      ok: true,
      body: '{"premium":true}',
      paid: true,
      payment: {
        method: "intents-transfer",
        success: true,
        merchant: "merchant.near",
        amount: "10000",
        fee: "30",
        total: "10030",
      },
      budget: { asset: USDC, spent: "10030" },
    });
    expect(r.data.payment.evidence[0]).toMatchObject({ kind: "settlement_tx", network: "near:mainnet", url: null });
    expect(h.served).toHaveLength(1);
  });

  it("returns an unpaid 402 when no requirement may be paid (allow-list)", async () => {
    h = await harness({
      options: (o) => ({ ...o, payer: { ...(o.payer as NonNullable<typeof o.payer>), allowedPayTo: ["other.near"] } }),
    });
    const r = await h.call("nearpay_fetch_paid", { url: "https://merchant.test/premium" });
    expect(r.data.error.code).toBe("pay_to_not_allowed");
    expect(h.served).toHaveLength(0);
  });

  it("refuses plain http resources outside localhost and over-limit payments", async () => {
    h = await harness();
    expect((await h.call("nearpay_fetch_paid", { url: "http://merchant.test/premium" })).data.error.code).toBe(
      "invalid_arguments",
    );
    const r = await h.call("nearpay_fetch_paid", { url: "https://merchant.test/premium", max_amount: "10029" });
    expect(r.data.error.code).toBe("spend_limit_exceeded");
  });

  it("pays cross-chain (near-intents) when configured, with deposit and settlement evidence", async () => {
    const o = origin();
    h = await harness({
      paywall: { amount: "1000000", origins: [{ asset_id: BASE_USDC }], includeIntentsTransfer: false },
      options: (opts) => ({
        ...opts,
        livemode: false,
        payer: { ...(opts.payer as NonNullable<typeof opts.payer>), crossChain: { originSigner: o.originSigner } },
      }),
    });
    // default limits: Base USDC 1.00 per call — the quote (1.012) exceeds it
    const refused = await h.call("nearpay_fetch_paid", { url: "https://merchant.test/premium" });
    expect(refused.data.error.code).toBe("spend_limit_exceeded");
    expect(o.deposits).toHaveLength(0);
    await h.close();
    h = await harness({
      paywall: { amount: "1000000", origins: [{ asset_id: BASE_USDC }], includeIntentsTransfer: false },
      options: (opts) => ({
        ...opts,
        payer: {
          ...(opts.payer as NonNullable<typeof opts.payer>),
          limits: limits({ [BASE_USDC]: "1100000" }, { [BASE_USDC]: "5000000" }),
          crossChain: { originSigner: o.originSigner },
        },
      }),
    });
    const r = await h.call("nearpay_fetch_paid", { url: "https://merchant.test/premium" });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      status: 200,
      paid: true,
      payment: {
        method: "near-intents",
        success: true,
        deposited: { network: "eip155:8453", asset: BASE_USDC, amount: "1012000" },
        refund_to: REFUND_TO,
      },
      budget: { asset: BASE_USDC, spent: "1012000" },
    });
    expect(r.data.payment.evidence.map((e: { kind: string }) => e.kind)).toStrictEqual([
      "deposit_tx",
      "settlement_tx",
      "agent_payment",
    ]);
    expect(o.deposits).toHaveLength(1);
    // the operation token never leaves the server
    const token = [...h.fac.nearOps.keys()][0] as string;
    expect(r.text).not.toContain(token);
    expect(h.logs.join("\n")).not.toContain(token);
  });

  it("answers pending for a slow settlement and resumes it without paying again", async () => {
    const o = origin();
    const store = memoryOperationStore();
    h = await harness({
      paywall: { amount: "1000000", origins: [{ asset_id: BASE_USDC }], includeIntentsTransfer: false },
      facilitator: { pendingNearSettles: 1 },
      options: (opts) => ({
        ...opts,
        payer: {
          ...(opts.payer as NonNullable<typeof opts.payer>),
          limits: limits({ [BASE_USDC]: "1100000" }, { [BASE_USDC]: "5000000" }),
          store,
          crossChain: { originSigner: o.originSigner },
        },
      }),
    });
    const r = await h.call("nearpay_fetch_paid", { url: "https://merchant.test/premium", max_wait_seconds: 0 });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ status: "pending", paid: true, operation: { state: "deposited" } });
    const id = r.data.operation.id as string;
    const spending = await h.call("nearpay_get_spending");
    expect(spending.data.open_operations).toHaveLength(1);
    expect(JSON.stringify(spending.data)).not.toContain("operationToken");
    const done = await h.call("nearpay_resume_paid_fetch", { operation_id: id });
    expect(done.data).toMatchObject({ status: 200, paid: true, payment: { method: "near-intents", operation_id: id } });
    expect(o.deposits).toHaveLength(1);
    const again = await h.call("nearpay_resume_paid_fetch", { operation_id: id });
    expect(again.data.error.code).toBe("operation_unknown");
  });

  it("resume needs cross-chain configured", async () => {
    h = await harness();
    expect((await h.call("nearpay_resume_paid_fetch", { operation_id: "np1:x" })).data.error.code).toBe(
      "cross_chain_not_configured",
    );
  });
});

describe("secrets", () => {
  it("never puts keys or secrets into logs or results", async () => {
    h = await harness({
      checkout: { intentStatuses: ["succeeded"] },
      options: (o) => ({
        ...o,
        payer: {
          ...(o.payer as NonNullable<typeof o.payer>),
          limits: limits({ [USDC]: "3000000" }, { [USDC]: "9000000" }),
        },
      }),
    });
    const results = [
      await h.call("nearpay_pay_checkout_session", { url: checkoutUrl }),
      await h.call("nearpay_pay_checkout_session", { url: invoiceUrl }),
      await h.call("nearpay_pay_checkout_session", { url: `https://evil.example/i/${INVOICE}#${INVOICE_SECRET}` }),
      await h.call("nearpay_fetch_paid", {
        url: "https://merchant.test/premium",
        headers: { authorization: "Bearer agent-token-123456789" },
      }),
    ];
    const everything = [...results.map((r) => r.text), ...h.logs].join("\n");
    for (const s of [SECRET, INVOICE_SECRET, "sk_test_merchant000000000000000000", "agent-token-123456789"]) {
      expect(everything).not.toContain(s);
    }
  });
});
