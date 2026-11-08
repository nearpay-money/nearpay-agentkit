/**
 * Cross-chain x402 (`exact` + `near-intents`, spec 0.3.0, agentpay §3.1): the paywall (`origins`) and the
 * agent client (`crossChain`) against the spec-driven facilitator fake, wired together through
 * `withPaywall` — quote → second 402 → deposit → settle, plus every refusal on both sides.
 */
import { type AgentSignerError, nearSigner, SpendingBudget, staticSaltProvider } from "@nearpay/agent-signer";
import {
  decodeX402Header,
  encodeX402Header,
  type NearIntentsPaymentRequirements,
  NearIntentsSettleResponse,
  X402PaymentRequiredAny,
} from "@nearpay/spec";
import { describe, expect, it, vi } from "vitest";
import {
  checkQuotedEntry,
  createPaywall,
  DepositNotSentError,
  type DepositRequest,
  facilitator,
  memoryOperationStore,
  type OriginSigner,
  type PaywallConfig,
  type PaywallResult,
  paymentOf,
  resumeX402Operation,
  type WithX402Options,
  withPaywall,
  withX402,
  X402ClientError,
} from "../src/index.js";
import { ARB_USDC, BASE_USDC, fakeFacilitator, ORIGINS, REFUND_TO, SECRET_KEY, USDC } from "./fake-facilitator.js";

const URL_ = "https://merchant.test/premium";
const TX = `0x${"ab".repeat(32)}`;
const PRICE = "1000000";
const config: PaywallConfig = {
  amount: PRICE,
  description: "Premium",
  origins: [{ asset_id: BASE_USDC }, { asset_id: ARB_USDC, max_timeout_s: 900 }],
};

function merchant(fakeOpts: Parameters<typeof fakeFacilitator>[0] = {}, cfg: PaywallConfig = config) {
  const fac = fakeFacilitator(fakeOpts);
  const served: unknown[] = [];
  const handler = withPaywall(
    async (req) => {
      served.push(paymentOf(req));
      return new Response("premium data", { status: 200 });
    },
    cfg,
    { secretKey: SECRET_KEY, apiBase: "https://api.test", fetch: fac.fetch },
  );
  const f = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(input instanceof Request ? input : new Request(String(input), init))) as typeof fetch;
  return { fac, served, fetch: f };
}

function origin(over: Partial<OriginSigner> = {}) {
  const deposits: DepositRequest[] = [];
  const signer: OriginSigner = {
    canPay: (network, asset) => Object.values(ORIGINS).some((o) => o.network === network && o.asset === asset),
    refundTo: () => REFUND_TO,
    deposit: async (d) => {
      deposits.push(d);
      return { txHash: TX };
    },
    ...over,
  };
  return { signer, deposits };
}

const limits = { [BASE_USDC]: 2_000_000, [ARB_USDC]: 2_000_000, [USDC]: 2_000_000 };

function agentOpts(o: OriginSigner, over: Partial<WithX402Options> = {}): WithX402Options & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    maxAmountPerRequest: limits,
    nonceSaltProvider: staticSaltProvider("252812b3"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
    crossChain: { originSigner: o, store: memoryOperationStore(), ...over.crossChain },
    sleeps,
  };
}

const settlementOf = (r: Response) =>
  NearIntentsSettleResponse.parse(decodeX402Header(r.headers.get("PAYMENT-RESPONSE") as string));

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as AgentSignerError | X402ClientError).code;
  }
  return "no error";
};

describe("near-intents end to end (withPaywall + withX402)", () => {
  it("quotes, deposits the quoted amount, settles and serves once", async () => {
    const m = merchant();
    const o = origin();
    const onPayment = vi.fn();
    const opts = agentOpts(o.signer, { onPayment });
    const r = await withX402(m.fetch, null, opts)(URL_);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("premium data");
    expect(m.fac.calls.map((c) => c.route)).toStrictEqual([
      "near-intents/requirements",
      "near-intents/verify",
      "near-intents/settle",
    ]);
    const op = [...m.fac.nearOps.values()][0];
    expect(o.deposits).toStrictEqual([
      {
        network: "eip155:8453",
        asset: ORIGINS[BASE_USDC]?.asset,
        originAssetId: BASE_USDC,
        amount: "1012000",
        payTo: op?.depositAddress,
      },
    ]);
    expect(op?.refundTo).toBe(REFUND_TO);
    expect(settlementOf(r)).toMatchObject({ success: true, network: "near:mainnet", amount: PRICE });
    expect(m.served).toStrictEqual([
      expect.objectContaining({ method: "near-intents", payer: REFUND_TO, resource: URL_ }),
    ]);
    expect(onPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "near-intents",
        replayed: false,
        operation: expect.objectContaining({ state: "settled", txHash: TX }),
      }),
    );
    const stored = await opts.crossChain?.store?.list();
    expect(stored?.map((s) => s.state)).toStrictEqual(["settled"]);
    // the facilitator got the paywall's own unquoted entry and resource
    const settleBody = m.fac.calls[2]?.body as {
      paymentRequirements: NearIntentsPaymentRequirements;
      paymentPayload: { resource: unknown };
    };
    expect(settleBody.paymentRequirements.amount).toBe("");
    expect(settleBody.paymentPayload.resource).toStrictEqual({ url: URL_, description: "Premium" });
  });

  it("retries settlement_pending with backoff 5 s → 30 s and the same token", async () => {
    const m = merchant({ pendingNearSettles: 5 });
    const o = origin();
    const opts = agentOpts(o.signer);
    const r = await withX402(m.fetch, null, opts)(URL_);
    expect(r.status).toBe(200);
    expect(opts.sleeps).toStrictEqual([5000, 10000, 20000, 30000, 30000]);
    expect(o.deposits).toHaveLength(1);
    const tokens = new Set(
      m.fac.calls
        .filter((c) => c.route === "near-intents/settle")
        .map(
          (c) =>
            (c.body as { paymentPayload: { payload: { operationToken: string } } }).paymentPayload.payload
              .operationToken,
        ),
    );
    expect(tokens.size).toBe(1);
  });

  it("stops waiting after maxWaitMs and resumes the stored operation later without depositing again", async () => {
    const m = merchant({ pendingNearSettles: 4 });
    const o = origin();
    let t = Date.now();
    const opts = agentOpts(o.signer, {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      crossChain: { originSigner: o.signer, maxWaitMs: 7_000 },
    });
    const store = opts.crossChain?.store;
    const e = await withX402(m.fetch, null, opts)(URL_).catch((x) => x);
    expect(e).toBeInstanceOf(X402ClientError);
    expect(e).toMatchObject({ code: "settlement_pending" });
    const id = (e as X402ClientError).operationId as string;
    expect((await store?.get(id))?.state).toBe("deposited");
    // another fetch of the same resource resumes instead of funding a second quote
    const again = await withX402(m.fetch, null, opts)(URL_).catch((x) => x);
    expect(again).toMatchObject({ code: "settlement_pending", operationId: id });
    const r = await resumeX402Operation(m.fetch, id, {
      ...opts,
      crossChain: { originSigner: o.signer, ...(store ? { store } : {}) },
    });
    expect(r.status).toBe(200);
    expect(o.deposits).toHaveLength(1);
    expect(m.fac.calls.filter((c) => c.route === "near-intents/verify")).toHaveLength(1);
    await expect(
      resumeX402Operation(m.fetch, id, {
        ...opts,
        crossChain: { originSigner: o.signer, ...(store ? { store } : {}) },
      }),
    ).rejects.toThrow(/already settled/);
    await expect(
      resumeX402Operation(m.fetch, "np1:nope", { ...opts, crossChain: { originSigner: o.signer } }),
    ).rejects.toThrow(/no stored operation/);
  });

  it("applies the spend limit to the quoted amount (origin units) before depositing", async () => {
    const m = merchant();
    const o = origin();
    const budget = new SpendingBudget({ perCall: limits, perSession: limits });
    const opts = agentOpts(o.signer, { maxAmountPerRequest: { [BASE_USDC]: 1_011_999 }, budget });
    expect(await code(withX402(m.fetch, null, opts)(URL_))).toBe("spend_limit_exceeded");
    expect(o.deposits).toHaveLength(0);
    expect(budget.usage(BASE_USDC).committed).toBe(0n);
    expect(m.fac.calls.map((c) => c.route)).toStrictEqual(["near-intents/requirements", "near-intents/verify"]);
  });

  it("counts the deposit against the session budget", async () => {
    const budget = new SpendingBudget({ perCall: limits, perSession: { [BASE_USDC]: 1_500_000, [ARB_USDC]: 0 } });
    const o = origin();
    const r = await withX402(merchant().fetch, null, agentOpts(o.signer, { budget }))(URL_);
    expect(r.status).toBe(200);
    expect(budget.usage(BASE_USDC)).toMatchObject({ committed: 1_012_000n, reserved: 0n });
    // the next payment would pass the session limit: refused before any deposit
    expect(await code(withX402(merchant().fetch, null, agentOpts(o.signer, { budget }))(URL_))).toBe(
      "spend_limit_exceeded",
    );
    expect(o.deposits).toHaveLength(1);
  });

  it("only pays allowed merchants and origins it can pay (otherwise the 402 comes back untouched)", async () => {
    const o = origin();
    const r = await withX402(merchant().fetch, null, agentOpts(o.signer, { allowedPayTo: ["other.near"] }))(URL_);
    expect(r.status).toBe(402);
    const none = origin({ canPay: () => false });
    expect((await withX402(merchant().fetch, null, agentOpts(none.signer))(URL_)).status).toBe(402);
    const m = merchant();
    const pick = await withX402(
      m.fetch,
      null,
      agentOpts(o.signer, { crossChain: { originSigner: o.signer, origins: [ARB_USDC] } }),
    )(URL_);
    expect(pick.status).toBe(200);
    expect(o.deposits[0]?.network).toBe("eip155:42161");
    expect(o.deposits[0]?.originAssetId).toBe(ARB_USDC);
  });

  it("returns a refused quote as received and deposits nothing", async () => {
    const m = merchant({ quoteRefusal: "invalid_exact_near_intents_quote_unavailable" });
    const o = origin();
    const r = await withX402(m.fetch, null, agentOpts(o.signer))(URL_);
    expect(r.status).toBe(402);
    expect(settlementOf(r)).toMatchObject({
      success: false,
      errorReason: "invalid_exact_near_intents_quote_unavailable",
    });
    expect(o.deposits).toHaveLength(0);
  });

  it("records a failed settlement (refund to refundTo) and returns it", async () => {
    const m = merchant({ nearOutcome: "insufficient" });
    const o = origin();
    const budget = new SpendingBudget({ perCall: limits, perSession: limits });
    const opts = agentOpts(o.signer, { budget });
    const r = await withX402(m.fetch, null, opts)(URL_);
    expect(r.status).toBe(402);
    expect(settlementOf(r)).toMatchObject({ errorReason: "exact_near_intents_insufficient_deposit" });
    expect((await opts.crossChain?.store?.list())?.[0]).toMatchObject({
      state: "failed",
      error: "exact_near_intents_insufficient_deposit",
    });
    expect(budget.usage(BASE_USDC).committed).toBe(1_012_000n); // the deposit left the wallet
    expect(m.served).toHaveLength(0);
  });

  it("refuses a quote whose refund deadline is too close", async () => {
    const o = origin();
    const r = withX402(merchant({ refundWindowS: 60 }).fetch, null, agentOpts(o.signer))(URL_);
    expect(await code(r)).toBe("quote_invalid");
    expect(o.deposits).toHaveLength(0);
  });

  it("an unknown deposit outcome blocks new quotes until resolved with the tx hash", async () => {
    const m = merchant();
    const o = origin({
      deposit: async () => {
        throw new Error("RPC timeout after broadcast");
      },
    });
    const budget = new SpendingBudget({ perCall: limits, perSession: limits });
    const opts = agentOpts(o.signer, { budget });
    const e = await withX402(m.fetch, null, opts)(URL_).catch((x) => x);
    expect(e).toMatchObject({ code: "deposit_unknown" });
    expect(budget.usage(BASE_USDC).committed).toBe(1_012_000n);
    expect(await code(withX402(m.fetch, null, opts)(URL_))).toBe("operation_pending");
    const id = (e as X402ClientError).operationId as string;
    const cc = { originSigner: o.signer, ...(opts.crossChain?.store ? { store: opts.crossChain.store } : {}) };
    expect(await code(resumeX402Operation(m.fetch, id, { ...opts, crossChain: cc }))).toBe("deposit_unknown");
    const r = await resumeX402Operation(m.fetch, id, { ...opts, crossChain: cc, txHash: TX });
    expect(r.status).toBe(200);
  });

  it("a deposit that was certainly not sent releases the budget and fails the operation", async () => {
    const o = origin({
      deposit: async () => {
        throw new DepositNotSentError("wallet locked");
      },
    });
    const budget = new SpendingBudget({ perCall: limits, perSession: limits });
    const opts = agentOpts(o.signer, { budget });
    await expect(withX402(merchant().fetch, null, opts)(URL_)).rejects.toThrow(DepositNotSentError);
    expect(budget.usage(BASE_USDC)).toMatchObject({ committed: 0n, reserved: 0n });
    expect((await opts.crossChain?.store?.list())?.[0]?.state).toBe("failed");
  });

  it("prefers intents-transfer when the signer's Intents balance covers it, else pays cross-chain", async () => {
    const signer = nearSigner({ keyPair: new Uint8Array(32).fill(5) });
    const o = origin();
    const rich = merchant();
    const r1 = await withX402(
      rich.fetch,
      signer,
      agentOpts(o.signer, { crossChain: { originSigner: o.signer, balance: async () => 10n ** 9n } }),
    )(URL_);
    expect(r1.status).toBe(200);
    expect(rich.fac.calls.map((c) => c.route)).toStrictEqual(["near-intents/requirements", "verify", "settle"]);
    const poor = merchant();
    const r2 = await withX402(
      poor.fetch,
      signer,
      agentOpts(o.signer, { crossChain: { originSigner: o.signer, balance: async () => 0n } }),
    )(URL_);
    expect(r2.status).toBe(200);
    expect(o.deposits).toHaveLength(1);
    // an unreadable balance keeps intents-transfer (a refused transfer moves nothing)
    const unknown = merchant();
    await withX402(
      unknown.fetch,
      signer,
      agentOpts(o.signer, {
        crossChain: { originSigner: o.signer, balance: async () => Promise.reject(new Error("rpc")) },
      }),
    )(URL_);
    expect(unknown.fac.calls.map((c) => c.route)).toContain("settle");
    // no balance provider: intents-transfer
    const plain = merchant();
    await withX402(plain.fetch, signer, agentOpts(o.signer))(URL_);
    expect(plain.fac.calls.map((c) => c.route)).toContain("settle");
  });

  it("uses a per-network refund address", async () => {
    const m = merchant();
    const o = origin();
    await withX402(
      m.fetch,
      null,
      agentOpts(o.signer, {
        crossChain: {
          originSigner: o.signer,
          refundTo: { "eip155:8453": "0x1111111111111111111111111111111111111111" },
          slippageBps: 100,
        },
      }),
    )(URL_);
    const quote = m.fac.calls[1]?.body as { paymentPayload: { payload: Record<string, unknown> } };
    expect(quote.paymentPayload.payload).toStrictEqual({
      type: "quote",
      refundTo: "0x1111111111111111111111111111111111111111",
      slippageTolerance: 100,
    });
    const m2 = merchant();
    await withX402(
      m2.fetch,
      null,
      agentOpts(o.signer, { crossChain: { originSigner: o.signer, refundTo: () => REFUND_TO } }),
    )(URL_);
    const m3 = merchant();
    await withX402(
      m3.fetch,
      null,
      agentOpts(o.signer, { crossChain: { originSigner: o.signer, refundTo: REFUND_TO } }),
    )(URL_);
    expect(o.deposits).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Paywall in isolation
// ---------------------------------------------------------------------------------------------

const request = (headers: Record<string, string> = {}, url = URL_) => ({
  url,
  header: (n: string) => headers[n.toLowerCase()] ?? null,
});

function paywall(fakeOpts: Parameters<typeof fakeFacilitator>[0] = {}, cfg: PaywallConfig = config) {
  const fac = fakeFacilitator(fakeOpts);
  const onError = vi.fn();
  const opts = { secretKey: SECRET_KEY, apiBase: "https://api.test", fetch: fac.fetch, onError };
  return { fac, onError, pw: createPaywall(cfg, opts), opts };
}

const requiredOf = (r: PaywallResult) =>
  X402PaymentRequiredAny.parse(
    decodeX402Header((r as { headers: Record<string, string> }).headers["PAYMENT-REQUIRED"] as string),
  );
const failureOf = (r: PaywallResult) =>
  NearIntentsSettleResponse.parse(decodeX402Header(r.headers["PAYMENT-RESPONSE"] as string));

async function unquoted(pw: ReturnType<typeof paywall>["pw"]) {
  const first = await pw(request());
  const req = requiredOf(first);
  const entry = req.accepts.find(
    (e) => (e.extra as { assetTransferMethod: string }).assetTransferMethod === "near-intents",
  );
  return { required: req, entry: entry as NearIntentsPaymentRequirements };
}

const quoteHeader = (entry: unknown, over: Record<string, unknown> = {}) =>
  encodeX402Header({
    x402Version: 2,
    resource: { url: URL_ },
    accepted: entry,
    payload: { type: "quote", refundTo: REFUND_TO },
    ...over,
  });

describe("createPaywall with origins", () => {
  it("issues both methods in one PAYMENT-REQUIRED through /x402/near-intents/requirements", async () => {
    const { fac, pw } = paywall();
    const { required } = await unquoted(pw);
    expect(required.accepts.map((e) => (e.extra as { assetTransferMethod: string }).assetTransferMethod)).toStrictEqual(
      ["intents-transfer", "near-intents", "near-intents"],
    );
    expect(fac.calls[0]?.body).toStrictEqual({
      resource: { url: URL_, description: "Premium" },
      amount: PRICE,
      origins: [{ asset_id: BASE_USDC }, { asset_id: ARB_USDC, max_timeout_s: 900 }],
      include_intents_transfer: true,
      max_timeout_s: 120,
      quote_window_s: 300,
    });
    const only = paywall(
      {},
      { ...config, includeIntentsTransfer: false, quoteWindowSeconds: 60, asset: USDC, payTo: "merchant.near" },
    );
    const r = requiredOf(await only.pw(request()));
    expect(r.accepts).toHaveLength(2);
    expect(only.fac.calls[0]?.body).toMatchObject({
      include_intents_transfer: false,
      quote_window_s: 60,
      asset_id: USDC,
      pay_to: "merchant.near",
    });
  });

  it("answers a quote with a second 402 holding quotedRequirements and never serves on it", async () => {
    const { pw, fac } = paywall();
    const { entry } = await unquoted(pw);
    const r = await pw(request({ "payment-signature": quoteHeader(entry) }));
    expect(r).toMatchObject({ paid: false, status: 402 });
    const quoted = requiredOf(r).accepts[0] as NearIntentsPaymentRequirements;
    expect(quoted).toMatchObject({
      amount: "1012000",
      network: entry.network,
      extra: { binding: entry.extra.binding },
    });
    expect(quoted.extra.operationToken).toMatch(/^k1\./);
    expect(fac.calls.at(-1)?.route).toBe("near-intents/verify");
    // a second quote for the same binding is refused upstream (single use)
    const again = await pw(request({ "payment-signature": quoteHeader(entry) }));
    expect(failureOf(again).errorReason).toBe("requirement_consumed");
  });

  it.each([
    [
      "amount",
      (e: NearIntentsPaymentRequirements) => ({
        ...e,
        extra: { ...e.extra, destination: { ...e.extra.destination, amount: "1" } },
      }),
    ],
    [
      "origin",
      (e: NearIntentsPaymentRequirements) => ({ ...e, extra: { ...e.extra, originAssetId: "nep141:other.near" } }),
    ],
    [
      "accepted entry",
      (e: NearIntentsPaymentRequirements) => ({ ...e, payTo: "0x76b4c56085ED136a8744D52bE956396624a730E8" }),
    ],
    [
      "accepted entry",
      (e: NearIntentsPaymentRequirements) => ({
        ...e,
        extra: { ...e.extra, operationToken: `k1.1.${"a".repeat(43)}` },
      }),
    ],
    [
      "binding",
      (e: NearIntentsPaymentRequirements) => {
        const { binding: _b, ...extra } = e.extra;
        return { ...e, extra };
      },
    ],
  ])("refuses a payload whose %s is not this resource's, without calling the facilitator", async (what, mutate) => {
    const { pw, fac } = paywall();
    const { entry } = await unquoted(pw);
    const r = await pw(request({ "payment-signature": quoteHeader(mutate(entry)) }));
    expect(failureOf(r)).toMatchObject({ success: false, errorReason: "invalid_payment_requirements" });
    expect(failureOf(r).errorMessage).toContain(what);
    expect(fac.calls).toHaveLength(1);
  });

  it("checks payTo, asset, window and resource against the configuration", async () => {
    const strict = paywall({}, { ...config, asset: USDC, payTo: "merchant.near" });
    const { entry } = await unquoted(strict.pw);
    const cases: [string, string][] = [
      [
        quoteHeader({
          ...entry,
          extra: { ...entry.extra, destination: { ...entry.extra.destination, recipient: "evil.near" } },
        }),
        "payTo",
      ],
      [
        quoteHeader({
          ...entry,
          extra: { ...entry.extra, destination: { ...entry.extra.destination, asset: "nep141:x.near" } },
        }),
        "asset",
      ],
      [quoteHeader(entry, { resource: { url: "https://merchant.test/cheap" } }), "resource"],
    ];
    for (const [h, what] of cases) {
      expect(failureOf(await strict.pw(request({ "payment-signature": h }))).errorMessage).toContain(what);
    }
    const arb = (await unquoted(strict.pw)).required.accepts[2] as NearIntentsPaymentRequirements;
    const r = await strict.pw(request({ "payment-signature": quoteHeader({ ...arb, maxTimeoutSeconds: 1800 }) }));
    expect(failureOf(r).errorMessage).toContain("maxTimeoutSeconds");
  });

  it("refuses a swapped origin network for a remembered binding", async () => {
    const { pw } = paywall();
    const { entry } = await unquoted(pw);
    const r = await pw(request({ "payment-signature": quoteHeader({ ...entry, network: "eip155:1" }) }));
    expect(failureOf(r).errorMessage).toContain("not the one issued");
  });

  it("refuses near-intents payloads when no origins are configured, and malformed ones", async () => {
    const { pw } = paywall();
    const { entry } = await unquoted(pw);
    const plain = paywall({}, { amount: PRICE });
    const r = await plain.pw(request({ "payment-signature": quoteHeader(entry) }));
    expect(failureOf(r)).toMatchObject({ errorReason: "invalid_payment_requirements", network: entry.network });
    const bad = await pw(request({ "payment-signature": quoteHeader(entry, { payload: { type: "quote" } }) }));
    expect(failureOf(bad).errorReason).toBe("invalid_payload");
  });

  it("works on another replica (no remembered entry): the facilitator compares the issued terms", async () => {
    const a = paywall();
    const { entry } = await unquoted(a.pw);
    const replica = createPaywall(config, a.opts);
    const r = await replica(request({ "payment-signature": quoteHeader(entry) }));
    expect(r).toMatchObject({ status: 402 });
    expect(requiredOf(r).accepts[0]?.amount).toBe("1012000");
  });

  it("refuses intents-transfer payloads when only near-intents is offered", async () => {
    const { pw: offered } = paywall();
    const transfer = (await unquoted(offered)).required.accepts[0];
    const only = paywall({}, { ...config, includeIntentsTransfer: false });
    const h = encodeX402Header({
      x402Version: 2,
      resource: { url: URL_ },
      accepted: transfer,
      payload: { signed: { standard: "raw_ed25519", payload: "{}", public_key: "ed25519:x", signature: "ed25519:y" } },
    });
    const r = await only.pw(request({ "payment-signature": h }));
    expect(r).toMatchObject({ status: 402 });
  });

  it("refuses a replayed deposit after serving (in process, and replayed from another replica)", async () => {
    const m = paywall();
    const o = origin();
    // pay through the client so a real deposit header exists
    let lastHeader = "";
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const h = req.headers.get("payment-signature");
      if (h) lastHeader = h;
      const out = await m.pw({ url: req.url, header: (n) => req.headers.get(n) });
      return new Response(out.paid ? "ok" : "{}", { status: out.paid ? 200 : out.status, headers: out.headers });
    }) as typeof fetch;
    expect((await withX402(f, null, agentOpts(o.signer))(URL_)).status).toBe(200);
    const replay = await m.pw(request({ "payment-signature": lastHeader }));
    expect(failureOf(replay).errorReason).toBe("exact_near_intents_operation_executed");
    const replica = createPaywall(config, m.opts);
    const fromReplica = await replica(request({ "payment-signature": lastHeader }));
    expect(failureOf(fromReplica).errorReason).toBe("exact_near_intents_operation_executed");
    // a quote for an already settled binding is refused locally too
    const quoteAgain = await m.pw(request({ "payment-signature": quoteHeader(JSON.parse(atob(lastHeader)).accepted) }));
    expect(failureOf(quoteAgain).errorReason).toBe("exact_near_intents_operation_executed");
  });

  it("answers pending to a concurrent deposit of an operation being settled", async () => {
    const fac = fakeFacilitator();
    const real = facilitator({ secretKey: SECRET_KEY, apiBase: "https://api.test", fetch: fac.fetch });
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = {
      ...real,
      nearIntentsSettle: async (b: Parameters<typeof real.nearIntentsSettle>[0]) => {
        await gate;
        return real.nearIntentsSettle(b);
      },
    };
    const pw = createPaywall(config, { secretKey: SECRET_KEY, facilitator: slow });
    const entry = requiredOf(await pw(request())).accepts[1] as NearIntentsPaymentRequirements;
    const q = requiredOf(await pw(request({ "payment-signature": quoteHeader(entry) })))
      .accepts[0] as NearIntentsPaymentRequirements;
    const dep = encodeX402Header({
      x402Version: 2,
      resource: { url: URL_ },
      accepted: entry,
      payload: { type: "deposit", operationToken: q.extra.operationToken, depositAddress: q.payTo, txHash: TX },
    });
    const first = pw(request({ "payment-signature": dep }));
    const second = await pw(request({ "payment-signature": dep }));
    expect(failureOf(second)).toMatchObject({ errorReason: "settlement_pending", transaction: TX });
    release();
    expect((await first).paid).toBe(true);
  });

  it("maps facilitator failures to 503 / 500", async () => {
    const down = paywall({ failWith: { requirements: 503 } });
    // near-intents/requirements is not in failWith's keys: force via a custom facilitator instead
    const fac = fakeFacilitator();
    const real = facilitator({ secretKey: SECRET_KEY, apiBase: "https://api.test", fetch: fac.fetch });
    const broken = createPaywall(config, {
      secretKey: SECRET_KEY,
      facilitator: { ...real, nearIntentsRequirements: async () => Promise.reject(new Error("down")) },
    });
    expect(await broken(request())).toMatchObject({ status: 503 });
    const pw = createPaywall(config, {
      secretKey: SECRET_KEY,
      facilitator: { ...real, nearIntentsVerify: async () => ({ isValid: true }) },
    });
    const { entry } = await unquoted(pw);
    expect(await pw(request({ "payment-signature": quoteHeader(entry) }))).toMatchObject({ status: 503 });
    const settleDown = createPaywall(config, {
      secretKey: SECRET_KEY,
      facilitator: { ...real, nearIntentsSettle: async () => Promise.reject(new Error("down")) },
    });
    const e2 = (await unquoted(settleDown)).entry;
    const q = requiredOf(await settleDown(request({ "payment-signature": quoteHeader(e2) })))
      .accepts[0] as NearIntentsPaymentRequirements;
    const dep = encodeX402Header({
      x402Version: 2,
      resource: { url: URL_ },
      accepted: e2,
      payload: { type: "deposit", operationToken: q.extra.operationToken, depositAddress: q.payTo, txHash: TX },
    });
    expect(await settleDown(request({ "payment-signature": dep }))).toMatchObject({ status: 503 });
    expect(down.pw).toBeTypeOf("function");
  });

  it("validates the configuration", () => {
    const o = { secretKey: SECRET_KEY };
    expect(() => createPaywall({ amount: 1, origins: [] }, o)).toThrow(/1–20/);
    expect(() => createPaywall({ amount: 1, origins: [{ asset_id: BASE_USDC }, { asset_id: BASE_USDC }] }, o)).toThrow(
      /twice/,
    );
    expect(() => createPaywall({ amount: 1, origins: [{ asset_id: "" }] }, o)).toThrow(/required/);
    expect(() => createPaywall({ amount: 1, origins: [{ asset_id: BASE_USDC, max_timeout_s: 59 }] }, o)).toThrow(
      /max_timeout_s/,
    );
    expect(() => createPaywall({ amount: 1, origins: [{ asset_id: BASE_USDC }], quoteWindowSeconds: 901 }, o)).toThrow(
      /quoteWindowSeconds/,
    );
    const legacy = { requirements: vi.fn(), verify: vi.fn(), settle: vi.fn(), supported: vi.fn() };
    expect(() =>
      createPaywall({ amount: 1, origins: [{ asset_id: BASE_USDC }] }, { ...o, facilitator: legacy }),
    ).toThrow(/near-intents routes/);
    expect(() => createPaywall({ amount: 1 }, { ...o, facilitator: legacy })).not.toThrow();
  });
});

describe("checkQuotedEntry", () => {
  const now = Date.parse("2026-11-08T10:00:00Z");
  const unq: NearIntentsPaymentRequirements = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "",
    maxTimeoutSeconds: 1800,
    extra: {
      assetTransferMethod: "near-intents",
      paymentFlow: "upfront",
      destination: { network: "near:mainnet", asset: USDC, amount: PRICE, recipient: "merchant.near" },
      binding: "np1:FkMXJmBuTZEMpEvn6a6VRVGugj435HBY98sUfKJhinuj",
      originAssetId: BASE_USDC,
    },
  };
  const q: NearIntentsPaymentRequirements = {
    ...unq,
    amount: "1012000",
    payTo: "0x76b4c56085ED136a8744D52bE956396624a730E8",
    extra: {
      ...unq.extra,
      operationToken: `k1.1794220320.${"a".repeat(43)}`,
      refundDeadline: "2026-11-08T10:30:00Z",
      minAmountIn: "1007000",
    },
  };
  it("accepts the quoted form of the entry", () => {
    expect(() => checkQuotedEntry(unq, q, now)).not.toThrow();
  });
  it.each([
    ["another binding", { extra: { ...q.extra, binding: "np1:x" } }],
    ["network, asset or window changed", { network: "eip155:1" }],
    ["network, asset or window changed", { maxTimeoutSeconds: 60 }],
    ["destination changed", { extra: { ...q.extra, destination: { ...q.extra.destination, recipient: "evil.near" } } }],
    ["destination changed", { extra: { ...q.extra, destination: { ...q.extra.destination, amount: "1" } } }],
    ["origin asset changed", { extra: { ...q.extra, originAssetId: "nep141:x" } }],
    ["no amount", { amount: "" }],
    ["no amount", { amount: "0" }],
    ["no deposit address", { payTo: "" }],
    ["no operation token", { extra: { ...q.extra, operationToken: undefined } }],
    ["minAmountIn above amount", { extra: { ...q.extra, minAmountIn: "2000000" } }],
    ["no refund deadline", { extra: { ...q.extra, refundDeadline: undefined } }],
    ["too close", { extra: { ...q.extra, refundDeadline: "2026-11-08T10:01:00Z" } }],
  ])("refuses: %s", (why, over) => {
    expect(() => checkQuotedEntry(unq, { ...q, ...over } as NearIntentsPaymentRequirements, now)).toThrow(why);
  });
});
