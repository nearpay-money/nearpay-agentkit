/**
 * A spec-driven fake of NearPay's x402 facilitator (lld/agentpay.md §3, §5–§7): issues single-use
 * bindings, verifies payloads with the kit Verifier code (signature, exactly the two transfers,
 * memo = binding, deadline window), settles idempotently on the payload hash. Requests and responses
 * are validated with the spec route schemas.
 */
import { createHash } from "node:crypto";
import {
  type NearIntentsPaymentRequirements,
  type PaymentRequirements,
  x402NearIntentsRequirements,
  x402NearIntentsSettle,
  x402NearIntentsVerify,
  x402Requirements,
  x402Settle,
  x402Verify,
  type z,
} from "@nearpay/spec";
import { verifySigned } from "@nearpay-internal/intents";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import canonicalize from "canonicalize";

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const SECRET_KEY = "sk_test_demo0000000000000000000000";
/** Origins the fake knows (from the spec vectors / rails registry). */
export const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
export const ORIGINS: Record<string, { network: string; asset: string }> = {
  [BASE_USDC]: { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  [ARB_USDC]: { network: "eip155:42161", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
};
export const REFUND_TO = "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317";

interface NearOp {
  binding: string;
  entry: NearIntentsPaymentRequirements;
  depositAddress: string;
  token: string;
  amountIn: string;
  refundTo: string;
  result?: Record<string, unknown>;
  reported?: boolean;
}

interface Issued {
  req: PaymentRequirements;
  resourceUrl: string;
  expiresAt: number;
  consumed: boolean;
}

export interface FakeFacilitatorOptions {
  now?: () => number;
  /** `settlement_pending` answers before the final outcome. */
  pendingSettles?: number;
  /** Force an HTTP status for a route (e.g. `{ requirements: 503 }`). */
  failWith?: Partial<Record<"requirements" | "verify" | "settle", number>>;
  /** Behave like a facilitator older than spec 0.1.5: no `extra.deadline`, no `replayed`. */
  legacy?: boolean;
  /** Verify answers valid for a consumed binding (agentpay caches verify results for 60 s). */
  cachedVerify?: boolean;
  /** near-intents: `settlement_pending` answers before the final outcome. */
  pendingNearSettles?: number;
  /** near-intents final outcome (default `success`). */
  nearOutcome?: "success" | "failed" | "insufficient" | "under";
  /** near-intents: the quote is refused with this reason. */
  quoteRefusal?: string;
  /** near-intents: the minted quote's amountIn (default amount × 1.012). */
  amountIn?: (amount: bigint) => bigint;
  /** near-intents: refund window of the quote (default the entry's maxTimeoutSeconds). */
  refundWindowS?: number;
}

function parse<T>(schema: { parse(v: unknown): T } | undefined, v: unknown): T {
  if (!schema) throw new Error("route has no schema");
  return schema.parse(v);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const apiError = (status: number, code: string) =>
  json(status, {
    error: {
      type: status >= 500 ? "api_error" : "invalid_request_error",
      code,
      message: code,
      doc_url: `https://docs.nearpay.money/errors/${code}`,
      request_id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
    },
  });

export function fakeFacilitator(o: FakeFacilitatorOptions = {}) {
  const now = o.now ?? Date.now;
  const issued = new Map<string, Issued>();
  const settled = new Map<string, string>();
  const calls: { route: string; body: unknown }[] = [];
  let pending = o.pendingSettles ?? 0;
  let nearPending = o.pendingNearSettles ?? 0;
  const nearIssued = new Map<
    string,
    { entry: NearIntentsPaymentRequirements; resourceUrl: string; consumed: boolean }
  >();
  const nearOps = new Map<string, NearOp>(); // by token
  const strip = (e: NearIntentsPaymentRequirements) => {
    const { indicativeAmount: _i, ...extra } = e.extra;
    return { ...e, extra };
  };
  const sameTerms = (a: NearIntentsPaymentRequirements, b: NearIntentsPaymentRequirements) =>
    canonicalize(strip(a)) === canonicalize(strip(b));

  function nearIntents(route: string, body: unknown): Response {
    if (route === "near-intents/requirements") {
      const b = parse(x402NearIntentsRequirements.body, body);
      const accepts: unknown[] = [];
      if (b.include_intents_transfer !== false) {
        const r = issueTransfer({
          resource: b.resource,
          amount: b.amount,
          asset_id: b.asset_id,
          pay_to: b.pay_to,
          max_timeout_s: b.max_timeout_s,
        });
        accepts.push(r);
      }
      const expiresAt = now() + (b.quote_window_s ?? 300) * 1000;
      for (const origin of b.origins) {
        const known = ORIGINS[origin.asset_id];
        if (!known) return apiError(400, "asset_unsupported");
        const binding = `np1:${bs58.encode(sha256(new TextEncoder().encode(`${nearIssued.size}:${origin.asset_id}:${b.resource.url}`)))}`;
        const entry: NearIntentsPaymentRequirements = {
          scheme: "exact",
          network: known.network,
          amount: "",
          asset: known.asset,
          payTo: "",
          maxTimeoutSeconds: origin.max_timeout_s ?? 1800,
          extra: {
            assetTransferMethod: "near-intents",
            paymentFlow: "upfront",
            destination: {
              network: "near:mainnet",
              asset: b.asset_id ?? USDC,
              amount: b.amount,
              recipient: b.pay_to ?? "merchant.near",
            },
            indicativeAmount: ((BigInt(b.amount) * 1012n) / 1000n).toString(),
            binding,
            deadline: new Date(expiresAt).toISOString(),
            originAssetId: origin.asset_id,
            slippageTolerance: { min: 10, max: 300, default: 50 },
          },
        };
        nearIssued.set(binding, { entry, resourceUrl: b.resource.url, consumed: false });
        accepts.push(entry);
      }
      return json(200, x402NearIntentsRequirements.response.parse({ x402Version: 2, resource: b.resource, accepts }));
    }
    const b = parse(x402NearIntentsVerify.body, body);
    const p = b.paymentPayload;
    const binding = b.paymentRequirements.extra.binding ?? "";
    const item = nearIssued.get(binding);
    const invalid = (reason: string) =>
      route === "near-intents/verify"
        ? json(200, { isValid: false, invalidReason: reason })
        : json(200, { success: false, transaction: "", network: p.accepted.network, errorReason: reason });
    if (!item) return invalid("requirement_unknown");
    if (!sameTerms(p.accepted, item.entry) || !sameTerms(b.paymentRequirements, item.entry)) {
      return invalid("invalid_payment_requirements");
    }
    if (p.resource.url !== item.resourceUrl) return invalid("invalid_payment_requirements");
    if (p.payload.type === "quote") {
      if (route !== "near-intents/verify") return invalid("invalid_payload");
      if (item.consumed) return invalid("requirement_consumed");
      if (now() > Date.parse(item.entry.extra.deadline ?? "")) return invalid("requirement_expired");
      item.consumed = true;
      if (o.quoteRefusal) return invalid(o.quoteRefusal);
      const amount = BigInt(item.entry.extra.destination.amount);
      const amountIn = (o.amountIn ?? ((a) => (a * 1012n) / 1000n))(amount);
      const refundDeadline = Math.floor(now() / 1000) + (o.refundWindowS ?? item.entry.maxTimeoutSeconds);
      const mac = bs58
        .encode(sha256(new TextEncoder().encode(binding)))
        .padEnd(43, "x")
        .slice(0, 43)
        .replace(/[^A-Za-z0-9_-]/g, "_");
      const token = `k1.${refundDeadline + 86_400}.${mac}`;
      const depositAddress = `0x${createHash("sha256").update(binding).digest("hex").slice(0, 40)}`;
      nearOps.set(token, {
        binding,
        entry: item.entry,
        depositAddress,
        token,
        amountIn: amountIn.toString(),
        refundTo: p.payload.refundTo,
      });
      return json(
        200,
        x402NearIntentsVerify.response.parse({
          isValid: true,
          extra: {
            depositAddress,
            amountIn: amountIn.toString(),
            minAmountIn: ((amountIn * 995n) / 1000n).toString(),
            refundDeadline: new Date(refundDeadline * 1000).toISOString(),
            operationToken: token,
          },
        }),
      );
    }
    const d = p.payload;
    const op = nearOps.get(d.operationToken);
    if (!op || op.binding !== binding || op.depositAddress !== d.depositAddress) {
      return invalid("invalid_exact_near_intents_token_invalid");
    }
    if (route === "near-intents/verify") return json(200, { isValid: true, payer: op.refundTo });
    if (!op.result) {
      if (nearPending > 0) {
        nearPending--;
        return json(
          200,
          x402NearIntentsSettle.response.parse({
            success: false,
            transaction: d.txHash,
            network: p.accepted.network,
            payer: op.refundTo,
            errorReason: "settlement_pending",
            extra: { status: "PROCESSING" },
          }),
        );
      }
      const outcome = o.nearOutcome ?? "success";
      op.result =
        outcome === "success"
          ? {
              success: true,
              transaction: bs58.encode(sha256(new TextEncoder().encode(d.txHash))),
              network: "near:mainnet",
              payer: op.refundTo,
              amount: op.entry.extra.destination.amount,
              extra: {
                originNetwork: p.accepted.network,
                originTxHash: d.txHash,
                agentPayment: "ap_01jbz9k3m4n5p6q7r8s9t0v1w2",
              },
            }
          : {
              success: false,
              transaction: "",
              network: p.accepted.network,
              payer: op.refundTo,
              errorReason:
                outcome === "insufficient"
                  ? "exact_near_intents_insufficient_deposit"
                  : "exact_near_intents_payment_failed",
              extra: { status: "REFUNDED", refundTo: op.refundTo },
            };
    }
    const replayed = op.reported === true;
    op.reported = true;
    return json(200, x402NearIntentsSettle.response.parse({ ...op.result, ...(replayed ? { replayed: true } : {}) }));
  }

  function check(
    body: z.output<typeof x402Verify.body & object>,
  ): { ok: true; payer: string; binding: string } | { ok: false; reason: string } {
    const { paymentPayload: p, paymentRequirements: r } = body;
    if (canonicalize(p.accepted) !== canonicalize(r)) return { ok: false, reason: "invalid_payment_requirements" };
    const item = issued.get(r.extra.binding);
    if (!item) return { ok: false, reason: "requirement_unknown" };
    if (canonicalize(item.req) !== canonicalize(r)) return { ok: false, reason: "invalid_payment_requirements" };
    if (p.resource && p.resource.url !== item.resourceUrl) return { ok: false, reason: "invalid_payment_requirements" };
    if (now() > item.expiresAt) return { ok: false, reason: "requirement_expired" };
    const v = verifySigned(p.payload.signed);
    if (!v.ok) return { ok: false, reason: v.reason };
    const m = v.message;
    const deadline = Date.parse(m.deadline);
    if (!(deadline > now() + 5000 && deadline <= item.expiresAt)) return { ok: false, reason: "deadline_invalid" };
    const want = [
      { intent: "transfer", receiver_id: r.payTo, tokens: { [r.asset]: r.amount }, memo: r.extra.binding },
      {
        intent: "transfer",
        receiver_id: r.extra.fee.to,
        tokens: { [r.asset]: r.extra.fee.amount },
        memo: r.extra.binding,
      },
    ];
    if (canonicalize(m.intents) !== canonicalize(want)) return { ok: false, reason: "recipient_mismatch" };
    return { ok: true, payer: m.signer_id, binding: r.extra.binding };
  }

  function issueTransfer(b: {
    resource: { url: string };
    amount: string;
    asset_id?: string | undefined;
    pay_to?: string | undefined;
    max_timeout_s?: number | undefined;
  }): PaymentRequirements {
    const window = b.max_timeout_s ?? 120;
    const expiresAt = now() + window * 1000;
    const fee = ((BigInt(b.amount) * 30n + 9_999n) / 10_000n).toString();
    const payTo = b.pay_to ?? "merchant.near";
    const asset = b.asset_id ?? USDC;
    const nonce16 = createHash("sha256").update(`${issued.size}:${b.resource.url}`).digest("hex").slice(0, 32);
    const binding = `np1:${bs58.encode(
      sha256(
        new TextEncoder().encode(
          canonicalize({
            account_id: "acct_01jbz9k3m4n5p6q7r8s9t0v1w2",
            resource_url: b.resource.url,
            payTo,
            asset,
            amount: b.amount,
            fee,
            nonce16,
            expires_at: Math.floor(expiresAt / 1000),
          }) as string,
        ),
      ),
    )}`;
    const req: PaymentRequirements = {
      scheme: "exact",
      network: "near:mainnet",
      amount: b.amount,
      asset,
      payTo,
      maxTimeoutSeconds: window,
      extra: {
        assetTransferMethod: "intents-transfer",
        paymentFlow: "authorization",
        fee: { to: "treasury.nearpay.near", amount: fee },
        binding,
        verifyingContract: "intents.near",
        ...(o.legacy ? {} : { deadline: new Date(expiresAt).toISOString() }),
      },
    };
    issued.set(binding, { req, resourceUrl: b.resource.url, expiresAt, consumed: false });
    return req;
  }

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = url.pathname.replace(/^\/x402\//, "");
    calls.push({ route, body });
    if (headers.get("authorization") !== `Bearer ${SECRET_KEY}`) return apiError(401, "authentication_required");
    if (headers.get("nearpay-version") !== "2026-11-01") return apiError(400, "invalid_request");
    const forced = o.failWith?.[route as "requirements"];
    if (forced) return apiError(forced, forced >= 500 ? "api_error" : "account_not_live");

    if (route === "requirements") {
      const b = parse(x402Requirements.body, body);
      return json(
        200,
        x402Requirements.response.parse({ x402Version: 2, resource: b.resource, accepts: [issueTransfer(b)] }),
      );
    }
    if (route.startsWith("near-intents/")) return nearIntents(route, body);
    if (route === "verify") {
      const b = parse(x402Verify.body, body);
      const c = check(b);
      const item = issued.get(b.paymentRequirements.extra.binding);
      if (c.ok && item?.consumed && !o.cachedVerify)
        return json(200, { isValid: false, invalidReason: "requirement_consumed" });
      return json(
        200,
        x402Verify.response.parse(
          c.ok ? { isValid: true, payer: c.payer } : { isValid: false, invalidReason: c.reason },
        ),
      );
    }
    if (route === "settle") {
      const b = parse(x402Settle.body, body);
      const hash = createHash("sha256")
        .update(canonicalize(b.paymentPayload.payload.signed) as string)
        .digest("hex");
      const done = settled.get(hash);
      const c = check(b);
      if (done && c.ok)
        return json(200, {
          success: true,
          transaction: done,
          network: "near:mainnet",
          payer: c.payer,
          amount: b.paymentRequirements.amount,
          ...(o.legacy ? {} : { replayed: true }),
        });
      if (!c.ok) return json(200, { success: false, transaction: "", network: "near:mainnet", errorReason: c.reason });
      const item = issued.get(c.binding) as Issued;
      if (item.consumed)
        return json(200, {
          success: false,
          transaction: "",
          network: "near:mainnet",
          errorReason: "requirement_consumed",
        });
      if (pending > 0) {
        pending--;
        return json(200, {
          success: false,
          transaction: "",
          network: "near:mainnet",
          payer: c.payer,
          errorReason: "settlement_pending",
        });
      }
      item.consumed = true;
      const tx = bs58.encode(sha256(new TextEncoder().encode(hash)));
      settled.set(hash, tx);
      return json(
        200,
        x402Settle.response.parse({
          success: true,
          transaction: tx,
          network: "near:mainnet",
          payer: c.payer,
          amount: b.paymentRequirements.amount,
        }),
      );
    }
    return apiError(404, "resource_missing");
  }) as typeof globalThis.fetch;

  return { fetch, calls, issued, nearIssued, nearOps };
}
