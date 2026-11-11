/** Unit coverage of the MCP building blocks: merchant client retries, error mapping, result summaries, logger. */
import { AgentSignerError, ApiCallError, nearSigner, SpendingBudget } from "@nearpay-money/agent-signer";
import { createCheckoutSession, getPaymentIntent, listPaymentIntents, z } from "@nearpay-money/spec";
import { memoryOperationStore, X402ClientError, type X402Operation } from "@nearpay-money/x402";
import { describe, expect, it, vi } from "vitest";
import {
  createNearPayMcpContext,
  createNearPayMcpServer,
  merchantClient,
  NearPayApiError,
  stderrLogger,
} from "../src/index.js";
import { errorInfo, operationOut, paymentOut, responseOut, ToolRefusal } from "../src/server.js";
import { checkoutSession, PI, paymentIntent } from "./support/fixtures.js";
import { MERCHANT_KEY, NEAR_SEED } from "./support/harness.js";

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const err = (status: number, code: string, headers: Record<string, string> = {}) =>
  ok(
    {
      error: {
        type: "api_error",
        code,
        message: code,
        param: "amount",
        doc_url: `https://docs.nearpay.money/errors/${code}`,
        request_id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
      },
    },
    status,
    headers,
  );

function scripted(...answers: (Response | Error)[]) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    const a = answers.shift();
    if (!a) throw new Error("no more answers");
    if (a instanceof Error) throw a;
    return a;
  });
  return { f: f as unknown as typeof fetch, seen };
}
const client = (f: typeof fetch) =>
  merchantClient({ apiKey: MERCHANT_KEY, apiBase: "https://api.test/", fetch: f, sleep: async () => {} });

describe("merchantClient", () => {
  it("refuses a malformed key", () => {
    expect(() => merchantClient({ apiKey: "pk_test_x", apiBase: "https://api.test" })).toThrow(RangeError);
  });
  it("serialises queries (arrays, skipping undefined) and parses tolerantly", async () => {
    const s = scripted(ok({ object: "list", data: [paymentIntent()], has_more: false, url: "/v1/payment_intents" }));
    const r = await client(s.f).call(listPaymentIntents, {
      query: { limit: 2, status: undefined, expand: ["a", "b"], x: null },
    });
    expect((r.data as { data: unknown[] }).data).toHaveLength(1);
    expect(s.seen[0]?.url).toBe("https://api.test/v1/payment_intents?limit=2&expand%5B%5D=a&expand%5B%5D=b");
    expect(r.requestId).toBeUndefined();
  });
  it("retries network errors and 5xx only on replay-safe routes", async () => {
    const s = scripted(new TypeError("reset"), err(503, "api_error"), ok(paymentIntent()));
    const r = await client(s.f).call(getPaymentIntent, { params: { id: PI } });
    expect((r.data as { id: string }).id).toBe(PI);
    expect(s.seen).toHaveLength(3);
    // createCheckoutSession is idempotent: true → retried with the same key
    const c = scripted(new TypeError("reset"), ok(checkoutSession(), 201, { "x-request-id": "req_1" }));
    const cr = await client(c.f).call(createCheckoutSession, { body: {} });
    expect(cr.requestId).toBe("req_1");
    const keys = c.seen.map((x) => new Headers(x.init?.headers).get("idempotency-key"));
    expect(keys[0]).toBe(keys[1]);
    const exhausted = scripted(new TypeError("a"), new TypeError("b"), new TypeError("c"));
    await expect(client(exhausted.f).call(getPaymentIntent, { params: { id: PI } })).rejects.toMatchObject({
      status: 0,
    });
  });
  it("retries 429 (Retry-After) and idempotency_in_progress, then reports the error envelope", async () => {
    const s = scripted(
      err(429, "rate_limited", { "retry-after": "2" }),
      err(409, "idempotency_in_progress"),
      err(400, "account_not_live"),
    );
    const e = await client(s.f)
      .call(createCheckoutSession, { body: {} })
      .catch((x) => x);
    expect(e).toBeInstanceOf(NearPayApiError);
    expect(e).toMatchObject({
      status: 400,
      code: "account_not_live",
      param: "amount",
      requestId: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
    });
    expect(s.seen).toHaveLength(3);
  });
  it("reports non-JSON errors and unexpected bodies", async () => {
    const s = scripted(new Response("<html>bad gateway</html>", { status: 400, headers: { "x-request-id": "req_9" } }));
    await expect(client(s.f).call(getPaymentIntent, { params: { id: PI } })).rejects.toMatchObject({
      status: 400,
      requestId: "req_9",
    });
    const b = scripted(ok({ nope: true }));
    await expect(client(b.f).call(getPaymentIntent, { params: { id: PI } })).rejects.toThrow(
      /unexpected response body/,
    );
    await expect(client(b.f).call(getPaymentIntent, {})).rejects.toThrow(/missing path parameter/);
  });
});

describe("errorInfo", () => {
  it("maps every error family to a stable code", () => {
    expect(errorInfo(new X402ClientError("quote_invalid", "x"))).toStrictEqual({ code: "quote_invalid", message: "x" });
    expect(errorInfo(new X402ClientError("settlement_pending", "x", "np1:a")).details).toStrictEqual({
      operation_id: "np1:a",
    });
    expect(errorInfo(new ApiCallError("m", 500, undefined, undefined))).toMatchObject({
      code: "api_error",
      details: { status: 500 },
    });
    expect(errorInfo(new ApiCallError("m", 400, "intent_invalid", "r"))).toMatchObject({
      details: { api_code: "intent_invalid" },
    });
    expect(errorInfo(new AgentSignerError("signer_error", "m"))).toStrictEqual({ code: "signer_error", message: "m" });
    expect(errorInfo(new NearPayApiError("m", 0))).toStrictEqual({
      code: "api_error",
      message: "m",
      details: { status: 0 },
    });
    expect(errorInfo(z.string().safeParse(1).error)).toMatchObject({ code: "invalid_arguments" });
    expect(errorInfo(new ToolRefusal("x_refused", "m"))).toStrictEqual({ code: "x_refused", message: "m" });
    expect(errorInfo(new Error("boom"))).toStrictEqual({ code: "internal_error", message: "boom" });
    expect(errorInfo("weird")).toStrictEqual({ code: "internal_error", message: "weird" });
  });
});

describe("result summaries", () => {
  it("returns text, binary and truncated bodies", async () => {
    expect(await responseOut(new Response("hello", { headers: { "content-type": "text/plain" } }), 10)).toMatchObject({
      body: "hello",
      truncated: false,
    });
    expect(
      await responseOut(new Response("hello world", { headers: { "content-type": "application/json" } }), 5),
    ).toMatchObject({
      body: "hello",
      body_bytes: 11,
      truncated: true,
    });
    const bin = await responseOut(
      new Response(new Uint8Array([0, 1, 2]), { headers: { "content-type": "image/png" } }),
      10,
    );
    expect(bin).toMatchObject({ body_base64: "AAEC", content_type: "image/png" });
    expect(await responseOut(new Response(null, { status: 204 }), 10)).toMatchObject({
      status: 204,
      content_type: null,
      body: "",
    });
  });
  it("summarises failed intents-transfer and near-intents payments", () => {
    const budget = new SpendingBudget({ perCall: 10n, perSession: 10n });
    expect(paymentOut([], budget, true)).toStrictEqual({ paid: false });
    const requirements = {
      amount: "5",
      asset: "nep141:usdc.near",
      payTo: "merchant.near",
      extra: { fee: { to: "t.near", amount: "1" } },
    };
    const failed = paymentOut(
      [{ method: "intents-transfer", requirements, settlement: null, replayed: false } as never],
      budget,
      true,
    );
    expect(failed).toMatchObject({
      paid: false,
      payment: { success: null, error_reason: null, evidence: [], total: "6" },
    });
    const op = {
      id: "np1:a",
      state: "failed",
      quoted: { network: "eip155:8453", asset: "0xabc", amount: "7", payTo: "0xdep", extra: { destination: {} } },
      refundTo: "0xref",
      resourceUrl: "https://x",
    } as unknown as X402Operation;
    const ni = paymentOut(
      [
        {
          method: "near-intents",
          operation: op,
          settlement: {
            success: false,
            errorReason: "exact_near_intents_payment_failed",
            transaction: "",
            network: "eip155:8453",
          },
          replayed: false,
        } as never,
      ],
      budget,
      true,
    );
    expect(ni).toMatchObject({
      paid: false,
      payment: { deposited: { asset: "0xabc" }, evidence: [], error_reason: "exact_near_intents_payment_failed" },
    });
    const live = paymentOut(
      [
        {
          method: "near-intents",
          operation: { ...op, txHash: "0xtx" },
          settlement: { success: true, transaction: "9gnJ", network: "near:mainnet" },
          replayed: true,
        } as never,
      ],
      budget,
      true,
    );
    expect((live as { payment: { evidence: { url: string }[] } }).payment.evidence.map((e) => e.url)).toStrictEqual([
      "https://basescan.org/tx/0xtx",
      "https://nearblocks.io/txns/9gnJ",
    ]);
    expect(operationOut({ ...op, error: "x" }, false)).toMatchObject({ error: "x", refund_deadline: null });
  });
});

describe("context and server", () => {
  it("warns about in-memory cross-chain operations and describes the mode", async () => {
    const logs: string[] = [];
    const ctx = createNearPayMcpContext({
      livemode: true,
      payer: {
        signer: nearSigner({ keyPair: NEAR_SEED }),
        allowedPayTo: ["m.near"],
        crossChain: {
          originSigner: { canPay: () => false, refundTo: () => "0x", deposit: async () => ({ txHash: "0x" }) },
        },
      },
      logger: (_l, msg) => logs.push(msg),
    });
    expect(logs[0]).toMatch(/in memory/);
    expect(createNearPayMcpServer(ctx)).toBeDefined();
    expect(ctx.merchant).toBeNull();
  });
  it("reports internal failures as errors", async () => {
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const store = memoryOperationStore();
    store.list = async () => Promise.reject(new Error("disk gone"));
    const server = createNearPayMcpServer({
      livemode: false,
      payer: { signer: nearSigner({ keyPair: NEAR_SEED }), allowedPayTo: ["m.near"], store },
      logger: () => {},
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const r = await c.callTool({ name: "nearpay_get_spending", arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe("internal_error");
    await c.close();
  });
});

describe("stderrLogger", () => {
  it("writes redacted JSON lines at or above the level", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = stderrLogger(["super-secret-value"], "info");
    log("debug", "hidden");
    log("warn", "key super-secret-value", { n: 1n, key: "sk_live_abc123" });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain('"n":"1"');
    expect(line).not.toContain("super-secret-value");
    expect(line).not.toContain("sk_live_abc123");
    stderrLogger()("error", "x");
    spy.mockRestore();
  });
});
