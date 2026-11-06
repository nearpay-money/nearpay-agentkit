/** `withX402` behaviour in isolation (scripted servers). */
import { nearSigner, staticSaltProvider } from "@nearpay/agent-signer";
import { decodeX402Header, encodeX402Header, PaymentPayload } from "@nearpay/spec";
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

/** A server that answers 402 until it sees PAYMENT-SIGNATURE. */
function server(accepts: unknown[] = [requirement]) {
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
        "PAYMENT-RESPONSE": encodeX402Header({
          success: true,
          transaction: "4Gk9abcdEFGH",
          network: "near:mainnet",
          payer: signer.signerId,
        }),
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
    expect(decodePaymentResponse(r)?.transaction).toBe("4Gk9abcdEFGH");
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

  it("decodePaymentResponse tolerates garbage", () => {
    expect(decodePaymentResponse(new Response(""))).toBeNull();
    expect(decodePaymentResponse(new Response("", { headers: { "PAYMENT-RESPONSE": "!!" } }))).toBeNull();
    expect(
      decodePaymentResponse(new Response("", { headers: { "PAYMENT-RESPONSE": encodeX402Header({}) } })),
    ).toBeNull();
  });
});
