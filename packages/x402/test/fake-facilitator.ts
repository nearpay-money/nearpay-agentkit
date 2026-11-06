/**
 * A spec-driven fake of NearPay's x402 facilitator (lld/agentpay.md §3, §5–§7): issues single-use
 * bindings, verifies payloads with the kit Verifier code (signature, exactly the two transfers,
 * memo = binding, deadline window), settles idempotently on the payload hash. Requests and responses
 * are validated with the spec route schemas.
 */
import { createHash } from "node:crypto";
import { type PaymentRequirements, x402Requirements, x402Settle, x402Verify, type z } from "@nearpay/spec";
import { verifySigned } from "@nearpay-internal/intents";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import canonicalize from "canonicalize";

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const SECRET_KEY = "sk_test_demo0000000000000000000000";

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
        },
      };
      issued.set(binding, { req, resourceUrl: b.resource.url, expiresAt, consumed: false });
      return json(200, x402Requirements.response.parse({ x402Version: 2, resource: b.resource, accepts: [req] }));
    }
    if (route === "verify") {
      const b = parse(x402Verify.body, body);
      const c = check(b);
      const item = issued.get(b.paymentRequirements.extra.binding);
      if (c.ok && item?.consumed) return json(200, { isValid: false, invalidReason: "requirement_consumed" });
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

  return { fetch, calls, issued };
}
