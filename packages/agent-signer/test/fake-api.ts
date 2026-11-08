/**
 * A spec-driven fake of the three routes an agent calls to pay a checkout session (agentpay §5,
 * sentinel §6). Requests are validated with the spec route schemas; responses too.
 */
import {
  agentPay,
  agentPayRequirements,
  createDepositInstructionsAttestation,
  createPublicInvoiceSession,
  getPublicCheckoutSession,
  getPublicInvoice,
  type IntentsRequirement,
} from "@nearpay/spec";
import { verifySigned } from "@nearpay-internal/intents";
import { ed25519 } from "@noble/curves/ed25519.js";
import canonicalize from "canonicalize";
import { hexBytes, vector } from "./support.js";

const sv = vector("sentinel-attestation.json");
export const SENTINEL_KEY = { kid: sv.key.kid as string, public_key: sv.key.public_key_base64url as string };
const SENTINEL_SEED = hexBytes(sv.key.seed_hex);

export const SESSION = "cs_01jbz9k3m4n5p6q7r8s9t0v1w2";
export const SECRET = `${SESSION}_secret_${"a".repeat(32)}`;
export const ATTEMPT = "pa_01jbz9k3m4n5p6q7r8s9t0v1w3";
export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const INVOICE = "in_01jbz9k3m4n5p6q7r8s9t0v1w4";
export const INVOICE_SECRET = `${INVOICE}_secret_${"b".repeat(32)}`;

export interface FakeOptions {
  now: number;
  livemode?: boolean;
  /** Mutates the requirement sentinel attests (a compromised payments/agentpay, or a stale view). */
  attestRequirement?: (r: IntentsRequirement) => IntentsRequirement;
  /** Signs with this seed instead of the sentinel key. */
  signWith?: Uint8Array;
  /** Attempt status in the agent_pay submission; a value newer than the spec skips strict validation. */
  attemptStatus?: string;
  sentinelStatus?: number;
  /** `agent_pay` answers this HTTP status (with an error envelope) instead of accepting. */
  agentPayStatus?: number;
  /** Successive `intent_status` values `getPublicCheckoutSession` reports (last one repeats). */
  intentStatuses?: string[];
  /** The hosted invoice's `payable` / `status` (default true / open). */
  invoicePayable?: boolean;
  invoiceStatus?: string;
  invoiceLivemode?: boolean;
  /** Client secret returned by the invoice session route (default the session's). */
  invoiceClientSecret?: string;
}

/** Parses with a route's (always present here) request schema. */
function parse<T>(schema: { parse(v: unknown): T } | undefined, v: unknown): T {
  if (!schema) throw new Error("route has no body schema");
  return schema.parse(v);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const error = (status: number, code: string) =>
  json(status, {
    error: {
      type: "invalid_request_error",
      code,
      message: code,
      doc_url: `https://docs.nearpay.money/errors/${code}`,
      request_id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
    },
  });

export function fakeCheckoutApi(o: FakeOptions) {
  const calls: string[] = [];
  let polls = 0;
  const submitted: unknown[] = [];
  const requirement: IntentsRequirement = {
    pay_to: "merchant.near",
    token: USDC,
    amount: "2000000",
    fee_to: "treasury.nearpay.near",
    fee_amount: "6000",
    binding: "np1:AQDxa2L6a5d8egVC7YP85UgtUCYp3cUotS6S3EsGcF7h",
    deadline: new Date(o.now + 120_000).toISOString(),
  };
  const livemode = o.livemode ?? false;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    const path = url.pathname.replace(/^\/api/, "");
    calls.push(`${init?.method} ${path}`);
    if (headers.get("NearPay-Version") !== "2026-11-01") return error(400, "invalid_request");
    if (path === `/v1/checkout/sessions/${SESSION}/agent_pay/requirements`) {
      if (headers.get("x-nearpay-client-secret") !== SECRET) return error(401, "client_secret_invalid");
      parse(agentPayRequirements.body, body);
      return json(
        200,
        agentPayRequirements.response.parse({
          object: "agent_pay_requirements",
          livemode,
          attempt_id: ATTEMPT,
          attestation_ticket: "eyJ0IjoxfQ.c2ln",
          requirement,
        }),
      );
    }
    if (path === "/v1/attestations/deposit_instructions") {
      const req = parse(createDepositInstructionsAttestation.body, body);
      if (o.sentinelStatus)
        return error(o.sentinelStatus, o.sentinelStatus === 503 ? "attestation_unavailable" : "attestation_refused");
      if (req.attempt_id !== ATTEMPT || req.attestation_ticket !== "eyJ0IjoxfQ.c2ln")
        return error(401, "ticket_invalid");
      const attested = (o.attestRequirement ?? ((r) => r))(req.requirement as IntentsRequirement);
      const attestation = {
        v: 1,
        kind: "intents_transfer",
        attempt_id: req.attempt_id,
        livemode: req.livemode,
        requirement: attested,
        merchant: { name: "Demo Shop", kyb_verified: false },
        destination: { asset_id: attested.token, chain: "near:mainnet", fingerprint: "YZMN-R81Z-BR" },
        issued_at: new Date(o.now).toISOString(),
        expires_at: attested.deadline,
      };
      const sig = ed25519.sign(
        new TextEncoder().encode(canonicalize(attestation) as string),
        o.signWith ?? SENTINEL_SEED,
      );
      return json(
        200,
        createDepositInstructionsAttestation.response.parse({
          attestation,
          kid: SENTINEL_KEY.kid,
          signature: Buffer.from(sig).toString("base64url"),
        }),
      );
    }
    if (path === `/v1/checkout/sessions/${SESSION}/public` && init?.method === "GET") {
      if (headers.get("x-nearpay-client-secret") !== SECRET) return error(401, "client_secret_invalid");
      const statuses = o.intentStatuses ?? ["processing"];
      const intent = statuses[Math.min(polls++, statuses.length - 1)] as string;
      return json(
        200,
        getPublicCheckoutSession.response.parse({
          id: SESSION,
          object: "checkout_session",
          livemode,
          status: intent === "succeeded" ? "complete" : "open",
          payment_intent: "pi_01jbz9k3m4n5p6q7r8s9t0v1w5",
          intent_status: intent,
          amount: "2000000",
          currency: "asset",
          asset_id: USDC,
          display: { merchant_name_unverified: "Demo Shop", description: "Widget" },
          expires_at: new Date(o.now + 3_600_000).toISOString(),
          settlement: { asset_id: USDC, chain: "near:mainnet", type: "intents_account" },
          ui_mode: "hosted",
          allowed_origins: [],
          success_url: "https://merchant.example/thanks",
          cancel_url: null,
          attempt: null,
        }),
      );
    }
    if (path === `/v1/invoices/${INVOICE}/public` || path === `/v1/invoices/${INVOICE}/public/sessions`) {
      if (headers.get("x-nearpay-invoice-secret") !== INVOICE_SECRET) return error(401, "invoice_secret_invalid");
      if (headers.get("x-nearpay-client-secret") !== null || headers.get("authorization") !== null) {
        return error(400, "invalid_request"); // anonymous routes: no other credential
      }
      if (init?.method === "GET") {
        return json(
          200,
          getPublicInvoice.response.parse({
            id: INVOICE,
            object: "invoice",
            livemode: o.invoiceLivemode ?? livemode,
            status: o.invoiceStatus ?? "open",
            number: "DEMO-0001",
            payable: o.invoicePayable ?? true,
            currency: "asset",
            asset_id: USDC,
            pricing_asset: { asset_id: USDC, symbol: "USDC", decimals: 6 },
            display: { merchant_name_unverified: "Demo Shop", description: null, footer: null },
            bill_to: { name: "Agent", email: null },
            lines: [],
            subtotal: "2000000",
            tax: "0",
            total: "2000000",
            total_excluding_tax: "2000000",
            total_tax_amounts: [],
            amount_due: "2000000",
            amount_paid: "0",
            amount_remaining: "2000000",
            issued_at: new Date(o.now).toISOString(),
            due_date: null,
            paid_at: null,
            voided_at: null,
            period_start: null,
            period_end: null,
            settlement: { asset_id: USDC, chain: "near:mainnet", type: "intents_account" },
            checkout_session: null,
          }),
        );
      }
      parse(createPublicInvoiceSession.body, body);
      return json(
        201,
        createPublicInvoiceSession.response.parse({
          object: "invoice_payment_session",
          checkout_session: SESSION,
          client_secret: o.invoiceClientSecret ?? SECRET,
          expires_at: new Date(o.now + 3_600_000).toISOString(),
          reused: false,
        }),
      );
    }
    if (path === `/v1/checkout/sessions/${SESSION}/agent_pay`) {
      if (o.agentPayStatus) return error(o.agentPayStatus, o.agentPayStatus >= 500 ? "api_error" : "intent_invalid");
      const { signed } = parse(agentPay.body, body);
      const r = verifySigned(signed);
      if (!r.ok) return error(400, "intent_invalid");
      submitted.push(signed);
      const submission = {
        object: "agent_pay_submission",
        status: "submitted",
        agent_payment: "ap_01jbz9k3m4n5p6q7r8s9t0v1w2",
        attempt: {
          id: ATTEMPT,
          object: "payment_attempt",
          livemode,
          status: "settling",
          method: "intents_transfer",
          visible: true,
          origin_asset_id: USDC,
          deposit: null,
          intents_requirement: requirement,
          attestation_ticket: null,
          failure_code: null,
          refunded_amount: null,
        },
      };
      if (o.attemptStatus)
        return json(202, { ...submission, attempt: { ...submission.attempt, status: o.attemptStatus } });
      return json(202, agentPay.response.parse(submission));
    }
    return error(404, "resource_missing");
  }) as typeof globalThis.fetch;
  return { fetch, calls, submitted, requirement };
}
