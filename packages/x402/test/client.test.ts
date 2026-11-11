/** `withX402` behaviour in isolation (scripted servers). */

import { verifySigned } from "@nearpay-internal/intents";
import { nearSigner, staticSaltProvider } from "@nearpay-money/agent-signer";
import { decodeX402Header, encodeX402Header, PaymentPayload } from "@nearpay-money/spec";
import { describe, expect, it, vi } from "vitest";
import { decodePaymentResponse, parsePaymentRequired, withX402, X402ClientError } from "../src/index.js";
import { USDC } from "./fake-facilitator.js";

const signer = nearSigner({ keyPair: new Uint8Array(32).fill(4) });
const requirement = {
  scheme: "exact",
  network: "near:mainnet",
  amount: "10000",
  asset: USDC,
  payTo: "merchant.near",
  maxTimeoutSeconds: 120,
  extra: {
    assetTransferMethod: "intents-transfer",
    paymentFlow: "authorization",
    fee: { to: "treasury.nearpay.near", amount: "30" },
    binding: "np1:AQDxa2L6a5d8egVC7YP85UgtUCYp3cUotS6S3EsGcF7h",
    verifyingContract: "intents.near",
  },
};
const evmRequirement = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "1",
  asset: "0xabc",
  payTo: "0xdef",
  maxTimeoutSeconds: 60,
  extra: {},
};
const required = (accepts: unknown[]) =>
  encodeX402Header({ x402Version: 2, resource: { url: "https://shop.test/premium" }, accepts });
const opts = { maxAmountPerRequest: 10_030, nonceSaltProvider: staticSaltProvider("252812b3") };

const settled = { success: true, transaction: "4Gk9abcdEFGH", network: "near:mainnet", payer: signer.signerId };

/** A server that answers 402 until it sees PAYMENT-SIGNATURE. */
function server(accepts: unknown[] = [requirement], settlement: Record<string, unknown> = settled) {
  const seen: Request[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    seen.push(req.clone());
    if (!req.headers.get("payment-signature")) {
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": required(accepts) } });
    }
    return new Response("paid", {
      status: 200,
      headers: {
        "PAYMENT-RESPONSE": encodeX402Header(settlement),
      },
    });
  });
  return { f: f as unknown as typeof fetch, seen, calls: f };
}

describe("withX402", () => {
  it("pays the NearPay requirement among others and retries once with the same request", async () => {
    const s = server([evmRequirement, requirement]);
    const onPayment = vi.fn();
    const r = await withX402(s.f, signer, { ...opts, onPayment })("https://shop.test/premium", {
      method: "POST",
      body: '{"q":1}',
      headers: { "x-agent": "1" },
    });
    expect(r.status).toBe(200);
    expect(s.seen).toHaveLength(2);
    const retry = s.seen[1] as Request;
    expect(retry.method).toBe("POST");
    expect(retry.headers.get("x-agent")).toBe("1");
    expect(await retry.text()).toBe('{"q":1}');
    const payload = PaymentPayload.parse(decodeX402Header(retry.headers.get("payment-signature") as string));
    expect(payload.accepted).toStrictEqual(requirement);
    expect(payload.resource).toStrictEqual({ url: "https://shop.test/premium" });
    expect(onPayment).toHaveBeenCalledOnce();
    expect(onPayment.mock.calls[0]?.[0]).toMatchObject({ settlement: settled, replayed: false });
    expect(decodePaymentResponse(r)?.transaction).toBe("4Gk9abcdEFGH");
  });

  it("signs the Verifier deadline at extra.deadline when the requirement carries it (spec 0.1.5)", async () => {
    const deadline = new Date(Date.now() + 90_000).toISOString();
    const withDeadline = { ...requirement, extra: { ...requirement.extra, deadline } };
    const s = server([withDeadline]);
    expect((await withX402(s.f, signer, opts)("https://shop.test/premium")).status).toBe(200);
    const payload = PaymentPayload.parse(
      decodeX402Header((s.seen[1] as Request).headers.get("payment-signature") as string),
    );
    const v = verifySigned(payload.payload.signed);
    expect(v.ok && v.message.deadline).toBe(deadline);
    expect(payload.accepted.extra.deadline).toBe(deadline);
  });

  it("falls back to half of maxTimeoutSeconds without extra.deadline", async () => {
    const s = server();
    const before = Date.now();
    await withX402(s.f, signer, opts)("https://shop.test/premium");
    const payload = PaymentPayload.parse(
      decodeX402Header((s.seen[1] as Request).headers.get("payment-signature") as string),
    );
    const v = verifySigned(payload.payload.signed);
    const signedAt = v.ok ? Date.parse(v.message.deadline) : Number.NaN;
    expect(signedAt).toBeGreaterThanOrEqual(before + 60_000 - 1);
    expect(signedAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("reports a replayed settlement to onPayment so it is not counted as a new payment", async () => {
    const s = server([requirement], { ...settled, replayed: true });
    const onPayment = vi.fn();
    const r = await withX402(s.f, signer, { ...opts, onPayment })("https://shop.test/premium");
    expect(r.status).toBe(200);
    expect(onPayment.mock.calls[0]?.[0]).toMatchObject({ replayed: true, settlement: { replayed: true } });
  });

  it("replays Request objects with their body", async () => {
    const s = server();
    const r = await withX402(
      s.f,
      signer,
      opts,
    )(new Request("https://shop.test/premium", { method: "PUT", body: "data" }));
    expect(r.status).toBe(200);
    expect(await (s.seen[1] as Request).text()).toBe("data");
  });

  it("refuses to pay above the spend limit or to another recipient (throws, does not retry)", async () => {
    const s = server();
    await expect(
      withX402(s.f, signer, { ...opts, maxAmountPerRequest: 10_029 })("https://shop.test/premium"),
    ).rejects.toMatchObject({
      code: "spend_limit_exceeded",
    });
    await expect(
      withX402(s.f, signer, { ...opts, allowedPayTo: ["shop.near"] })("https://shop.test/premium"),
    ).rejects.toMatchObject({
      code: "pay_to_not_allowed",
    });
    expect(s.calls).toHaveBeenCalledTimes(2);
  });

  it("returns non-402 responses and 402s it cannot pay untouched", async () => {
    const ok = vi.fn(async () => new Response("free"));
    expect(await (await withX402(ok as unknown as typeof fetch, signer, opts)("https://x.test")).text()).toBe("free");
    const variants: Record<string, string>[] = [
      {},
      { "PAYMENT-REQUIRED": "!!" },
      { "PAYMENT-REQUIRED": required([evmRequirement]) },
    ];
    for (const headers of variants) {
      const f = vi.fn(async () => new Response("{}", { status: 402, headers }));
      const r = await withX402(f as unknown as typeof fetch, signer, opts)("https://x.test");
      expect(r.status).toBe(402);
      expect(f).toHaveBeenCalledOnce();
    }
  });

  it("cannot replay a streamed body", async () => {
    const s = server();
    const body = new ReadableStream({ start: (c) => c.close() });
    await expect(
      withX402(s.f, signer, opts)("https://shop.test/premium", { method: "POST", body, duplex: "half" } as RequestInit),
    ).rejects.toBeInstanceOf(X402ClientError);
  });
});

describe("header helpers", () => {
  it("parsePaymentRequired rejects other versions and shapes", () => {
    expect(parsePaymentRequired(null)).toBeNull();
    expect(parsePaymentRequired(encodeX402Header("x"))).toBeNull();
    expect(
      parsePaymentRequired(encodeX402Header({ x402Version: 1, resource: { url: "https://a.b" }, accepts: [] })),
    ).toBeNull();
    expect(parsePaymentRequired(required([requirement]))?.accepts).toHaveLength(1);
  });

  it("parses tolerantly: unknown open-enum values are kept (spec 0.1.5), closed ones still refused", () => {
    const failure = { success: false, transaction: "", network: "near:mainnet", errorReason: "solar_flare" };
    const h = (v: unknown) => new Response("", { headers: { "PAYMENT-RESPONSE": encodeX402Header(v) } });
    expect(decodePaymentResponse(h(failure))?.errorReason).toBe("solar_flare");
    expect(decodePaymentResponse(h({ ...failure, network: "near:testnet" }))).toBeNull();
  });

  it("decodePaymentResponse tolerates garbage", () => {
    expect(decodePaymentResponse(new Response(""))).toBeNull();
    expect(decodePaymentResponse(new Response("", { headers: { "PAYMENT-RESPONSE": "!!" } }))).toBeNull();
    expect(
      decodePaymentResponse(new Response("", { headers: { "PAYMENT-RESPONSE": encodeX402Header({}) } })),
    ).toBeNull();
  });
});

describe("withX402 budget and parsing", () => {
  it("commits the debit of a settled payment and releases a definite refusal", async () => {
    const { SpendingBudget } = await import("@nearpay-money/agent-signer");
    const budget = new SpendingBudget({ perCall: 20_000, perSession: 30_000 });
    const ok = server();
    expect((await withX402(ok.f, signer, { ...opts, budget })("https://shop.test/premium")).status).toBe(200);
    expect(budget.usage(USDC).committed).toBe(10_030n);
    const refused = server([requirement], {
      success: false,
      transaction: "",
      network: "near:mainnet",
      errorReason: "insufficient_balance",
    });
    const f402 = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const r = await refused.f(input, init);
      return r.status === 200 ? new Response("{}", { status: 402, headers: r.headers }) : r;
    }) as unknown as typeof fetch;
    expect((await withX402(f402, signer, { ...opts, budget })("https://shop.test/premium")).status).toBe(402);
    expect(budget.usage(USDC)).toMatchObject({ committed: 10_030n, reserved: 0n });
    // a pending answer counts as spent (the payment may still execute)
    const pending = server([requirement], {
      success: false,
      transaction: "",
      network: "near:mainnet",
      errorReason: "settlement_pending",
    });
    const fp = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const r = await pending.f(input, init);
      return r.status === 200 ? new Response("{}", { status: 402, headers: r.headers }) : r;
    }) as unknown as typeof fetch;
    await withX402(fp, signer, { ...opts, budget })("https://shop.test/premium");
    expect(budget.usage(USDC).committed).toBe(20_060n);
    // session limit reached: refused before signing
    await expect(withX402(ok.f, signer, { ...opts, budget })("https://shop.test/premium")).rejects.toThrow(
      /session limit/,
    );
  });
  it("commits when the paid retry fails in transport, releases when signing fails", async () => {
    const { SpendingBudget } = await import("@nearpay-money/agent-signer");
    const budget = new SpendingBudget({ perCall: 20_000, perSession: 100_000 });
    let n = 0;
    const flaky = (async () => {
      if (n++ === 0)
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": required([requirement]) } });
      throw new TypeError("socket hang up");
    }) as unknown as typeof fetch;
    await expect(withX402(flaky, signer, { ...opts, budget })("https://shop.test/premium")).rejects.toThrow(/hang up/);
    expect(budget.usage(USDC).committed).toBe(10_030n);
    const badSigner = { ...signer, sign: async () => Promise.reject(new Error("hsm offline")) };
    await expect(withX402(server().f, badSigner, { ...opts, budget })("https://shop.test/premium")).rejects.toThrow(
      /hsm/,
    );
    expect(budget.usage(USDC)).toMatchObject({ committed: 10_030n, reserved: 0n });
  });
  it("parses near-intents entries next to intents-transfer ones and skips broken ones", () => {
    const ni = {
      scheme: "exact",
      network: "eip155:8453",
      amount: "",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "",
      maxTimeoutSeconds: 1800,
      extra: {
        assetTransferMethod: "near-intents",
        paymentFlow: "upfront",
        destination: { network: "near:mainnet", asset: USDC, amount: "1", recipient: "merchant.near" },
      },
    };
    const p = parsePaymentRequired(required([requirement, ni, { ...ni, extra: { ...ni.extra, destination: null } }]));
    expect(p?.accepts).toHaveLength(1);
    expect(p?.nearIntents).toHaveLength(1);
    expect(withX402).toBeTypeOf("function");
  });
  it("hands back a 402 without NearPay entries untouched when there is no signer", async () => {
    const s = server();
    const r = await withX402(s.f, null, opts)("https://shop.test/premium");
    expect(r.status).toBe(402);
    expect(s.seen).toHaveLength(1);
  });
});
