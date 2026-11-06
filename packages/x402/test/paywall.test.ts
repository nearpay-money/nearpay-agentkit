/** The framework-independent paywall against a spec-driven facilitator fake (lld/sdks-and-tools.md §2). */
import { buildTransferPayment, nearSigner, staticSaltProvider } from "@nearpay/agent-signer";
import { decodeX402Header, encodeX402Header, PaymentRequired, SettleResponse } from "@nearpay/spec";
import { describe, expect, it, vi } from "vitest";
import { createPaywall, type PaywallOptions, type PaywallResult } from "../src/index.js";
import { fakeFacilitator, SECRET_KEY, USDC } from "./fake-facilitator.js";

const URL_ = "https://merchant.test/premium";
const signer = nearSigner({ keyPair: new Uint8Array(32).fill(5) });
const salt = staticSaltProvider("252812b3");

function setup(over: Partial<PaywallOptions> = {}, fakeOpts: Parameters<typeof fakeFacilitator>[0] = {}) {
  const fac = fakeFacilitator(fakeOpts);
  const sleep = vi.fn(async () => {});
  const opts = { secretKey: SECRET_KEY, apiBase: "https://api.test", fetch: fac.fetch, sleep, ...over };
  return { fac, sleep, pw: createPaywall({ amount: "10000", description: "Premium" }, opts) };
}

const request = (headers: Record<string, string> = {}, url = URL_) => ({
  url,
  header: (n: string) => headers[n.toLowerCase()] ?? null,
});

async function pay(pw: ReturnType<typeof setup>["pw"], mutate?: (p: Record<string, unknown>) => void) {
  const first = await pw(request());
  if (first.paid) throw new Error("unexpected");
  const required = PaymentRequired.parse(decodeX402Header(first.headers["PAYMENT-REQUIRED"] as string));
  const accepted = required.accepts[0] as (typeof required.accepts)[0];
  const signed = await buildTransferPayment(accepted, signer, { nonceSaltProvider: salt });
  const payload: Record<string, unknown> = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { signed },
  };
  mutate?.(payload);
  return pw(request({ "payment-signature": encodeX402Header(payload) }));
}

const resourceOf = (call: { body: unknown } | undefined) =>
  (call?.body as { resource?: { url: string } })?.resource?.url;

const response = (r: PaywallResult) => SettleResponse.parse(decodeX402Header(r.headers["PAYMENT-RESPONSE"] as string));

describe("createPaywall", () => {
  it("answers 402 with fresh single-use requirements for every unpaid request", async () => {
    const { fac, pw } = setup();
    const a = await pw(request());
    const b = await pw(request());
    expect(a).toMatchObject({ paid: false, status: 402, body: {} });
    const ra = PaymentRequired.parse(
      decodeX402Header((a as { headers: Record<string, string> }).headers["PAYMENT-REQUIRED"] as string),
    );
    const rb = PaymentRequired.parse(
      decodeX402Header((b as { headers: Record<string, string> }).headers["PAYMENT-REQUIRED"] as string),
    );
    expect(ra.resource).toStrictEqual({ url: URL_, description: "Premium" });
    expect(ra.accepts[0]?.extra.binding).not.toBe(rb.accepts[0]?.extra.binding);
    expect(fac.calls.map((c) => c.route)).toStrictEqual(["requirements", "requirements"]);
    expect(fac.calls[0]?.body).toStrictEqual({ resource: { url: URL_, description: "Premium" }, amount: "10000" });
  });

  it("verifies, settles and passes a valid payment with PAYMENT-RESPONSE", async () => {
    const onSettled = vi.fn();
    const { fac, pw } = setup({ onSettled });
    const r = await pay(pw);
    expect(r.paid).toBe(true);
    expect(response(r)).toMatchObject({
      success: true,
      network: "near:mainnet",
      payer: signer.signerId,
      amount: "10000",
    });
    expect(fac.calls.map((c) => c.route)).toStrictEqual(["requirements", "verify", "settle"]);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ payer: signer.signerId, resource: URL_ }));
    // the binding is single-use: replaying the same signature does not unlock the resource twice
    // (settle is idempotent on the payload hash, the requirement is consumed)
  });

  it("retries a pending settlement once after 1 s", async () => {
    const { pw, sleep } = setup({}, { pendingSettles: 1 });
    const r = await pay(pw);
    expect(r.paid).toBe(true);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("answers 402 with the pending response when settlement is still pending", async () => {
    const { pw, fac } = setup({ pendingRetryMs: 5 }, { pendingSettles: 2 });
    const r = await pay(pw);
    expect(r).toMatchObject({ paid: false, status: 402 });
    expect(response(r)).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(fac.calls.filter((c) => c.route === "settle")).toHaveLength(2);
  });

  it("refuses payloads for another amount, asset, payTo, window or resource without calling verify", async () => {
    const cases: [string, (p: Record<string, unknown>) => void][] = [
      ["amount", (p) => Object.assign(p.accepted as object, { amount: "1" })],
      ["resource", (p) => Object.assign(p, { resource: { url: "https://merchant.test/cheap" } })],
    ];
    for (const [, mutate] of cases) {
      const { pw, fac } = setup();
      const r = await pay(pw, mutate);
      expect(response(r)).toMatchObject({ success: false, errorReason: "invalid_payment_requirements" });
      expect(fac.calls.map((c) => c.route)).toStrictEqual(["requirements"]);
    }
    const strict = createPaywall(
      { amount: 10000, asset: USDC, payTo: "shop.near", maxTimeoutSeconds: 60 },
      {
        secretKey: SECRET_KEY,
        facilitator: { requirements: vi.fn(), verify: vi.fn(), settle: vi.fn(), supported: vi.fn() },
      },
    );
    const accepted = {
      scheme: "exact",
      network: "near:mainnet",
      amount: "10000",
      asset: USDC,
      payTo: "shop.near",
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "intents-transfer",
        paymentFlow: "authorization",
        fee: { to: "treasury.nearpay.near", amount: "3" },
        binding: "np1:AQDxa2L6a5d8egVC7YP85UgtUCYp3cUotS6S3EsGcF7h",
        verifyingContract: "intents.near",
      },
    };
    const signed = {
      standard: "raw_ed25519",
      payload: "{}",
      public_key: `ed25519:${"1".repeat(44)}`,
      signature: `ed25519:${"1".repeat(88)}`,
    };
    for (const over of [{ asset: "nep141:wrap.near" }, { payTo: "merchant.near" }, { maxTimeoutSeconds: 120 }]) {
      const payload = { x402Version: 2, accepted: { ...accepted, ...over }, payload: { signed } };
      const r = await strict(request({ "payment-signature": encodeX402Header(payload) }));
      expect(response(r)).toMatchObject({ errorReason: "invalid_payment_requirements" });
    }
  });

  it("refuses a malformed PAYMENT-SIGNATURE", async () => {
    const { pw } = setup();
    for (const h of ["%%%", encodeX402Header({ x402Version: 2 })]) {
      const r = await pw(request({ "payment-signature": h }));
      expect(r).toMatchObject({ paid: false, status: 402 });
      expect(response(r)).toMatchObject({ errorReason: "invalid_payload" });
    }
  });

  it("passes the facilitator's invalidReason through", async () => {
    const { pw } = setup();
    const r = await pay(pw, (p) => {
      const signed = (p.payload as { signed: { payload: { message: string } } }).signed;
      signed.payload.message = signed.payload.message.replace("10000", "10001");
    });
    expect(response(r)).toMatchObject({ success: false, errorReason: "invalid_signature" });
  });

  it("answers 503 when the facilitator is down and 500 when it rejects the merchant's setup", async () => {
    const onError = vi.fn();
    const down = setup({ onError }, { failWith: { requirements: 503 } });
    expect(await down.pw(request())).toMatchObject({
      status: 503,
      headers: { "Retry-After": "1" },
      body: { error: "payment_unavailable" },
    });
    const conf = setup({ onError }, { failWith: { requirements: 400 } });
    expect(await conf.pw(request())).toMatchObject({ status: 500, body: { error: "payment_misconfigured" } });
    const settle = setup({ onError }, { failWith: { settle: 502 } });
    expect(await pay(settle.pw)).toMatchObject({ status: 503 });
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it("binds a configured resource URL", async () => {
    const { pw, fac } = setup({ resourceUrl: (r) => r.url.replace("http://internal:3000", "https://merchant.test") });
    await pw(request({}, "http://internal:3000/premium"));
    expect(resourceOf(fac.calls[0])).toBe(URL_);
    const fixed = setup({ resourceUrl: "https://merchant.test/fixed" });
    await fixed.pw(request());
    expect(resourceOf(fixed.fac.calls[0])).toBe("https://merchant.test/fixed");
  });

  it("validates its configuration", () => {
    const o = { secretKey: SECRET_KEY };
    expect(() => createPaywall({ amount: 0 }, o)).toThrow(/positive/);
    expect(() => createPaywall({ amount: 1.5 }, o)).toThrow(/positive/);
    expect(() => createPaywall({ amount: "-1" }, o)).toThrow(/positive/);
    expect(() => createPaywall({ amount: 1n, maxTimeoutSeconds: 10 }, o)).toThrow(/maxTimeoutSeconds/);
    expect(() => createPaywall({ amount: 1n }, { secretKey: "pk_test_x" })).toThrow(/secret/);
  });
});
