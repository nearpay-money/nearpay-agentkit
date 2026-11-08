/**
 * An agent paying a NearPay checkout session from its NEAR Intents balance (system trace T5,
 * lld/agentpay.md §5, lld/sdks-and-tools.md §2):
 *
 *   1. `POST /v1/checkout/sessions/{id}/agent_pay/requirements {payer}` → attempt + requirement + ticket
 *   2. `POST /v1/attestations/deposit_instructions` → sentinel co-signature of that requirement
 *   3. verify it with a pinned key and compare every field (refuse on any mismatch: nothing is signed)
 *   4. sign the two transfers (`buildTransferPayment`) and `POST …/agent_pay {signed}`
 *
 * Step 3 is the same two-party release a human gets in the hosted checkout (FR-PAY-10, audit S-05):
 * a compromised payments or agentpay cannot make the agent pay another account.
 */
import {
  type AgentPayRequirements,
  agentPay,
  agentPayRequirements,
  createDepositInstructionsAttestation,
  getPublicCheckoutSession,
  HEADERS,
  type IntentsRequirement,
  type MultiPayload,
  type PublicCheckoutSession,
  type SignedAttestation,
  type z,
} from "@nearpay/spec";
import { PINNED_SENTINEL_KEYS, type PinnedSentinelKey, verifyAttestation } from "./attestation.js";
import { AgentSignerError } from "./errors.js";
import { ApiCallError, callRoute } from "./http.js";
import { enforceSpendPolicy, type SpendLimit } from "./limits.js";
import { type BuildTransferOptions, buildTransferPayment, transferTerms } from "./payment.js";
import type { IntentSigner } from "./signers.js";

const CLIENT_SECRET_RE = /^(cs_[0-9a-z]{26})_secret_[0-9A-Za-z]{32}$/;

export interface CheckoutSessionRef {
  sessionId: string;
  clientSecret: string;
  /** API base the payer routes live under, e.g. `https://pay.nearpay.money/api` or `https://api.nearpay.money`. */
  apiBase: string;
}

/** A hosted checkout URL (`https://pay…/c/cs_…#<client secret>`) or explicit session coordinates. */
export type CheckoutTarget = { url: string; apiBase?: string } | CheckoutSessionRef;

/**
 * Reads a hosted or embedded checkout URL. The client secret travels in the fragment; the API is
 * reached same-origin under `/api` (lld/platform.md §1) unless `apiBase` is given.
 */
export function parseCheckoutUrl(url: string, apiBase?: string): CheckoutSessionRef {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AgentSignerError("invalid_requirements", "checkout URL is not a URL");
  }
  const path = /^\/(?:c|embed)\/(cs_[0-9a-z]{26})\/?$/.exec(u.pathname);
  const secret = decodeURIComponent(u.hash.slice(1));
  const m = CLIENT_SECRET_RE.exec(secret);
  if (!path || !m || m[1] !== path[1]) {
    throw new AgentSignerError(
      "invalid_requirements",
      "not a checkout URL with a client secret (…/c/cs_…#cs_…_secret_…)",
    );
  }
  return { sessionId: path[1] as string, clientSecret: secret, apiBase: apiBase ?? `${u.origin}/api` };
}

export function resolveTarget(t: CheckoutTarget): CheckoutSessionRef {
  if ("url" in t) return parseCheckoutUrl(t.url, t.apiBase);
  const m = CLIENT_SECRET_RE.exec(t.clientSecret);
  if (!m || m[1] !== t.sessionId)
    throw new AgentSignerError("invalid_requirements", "client secret does not match the session");
  return t;
}

export interface CheckoutPaymentOptions extends BuildTransferOptions {
  /** Sentinel keys pinned out of band; default: {@link PINNED_SENTINEL_KEYS}. */
  pinnedKeys?: readonly PinnedSentinelKey[];
  /** Spend limit on amount + fee (base units), see `SpendLimit`. */
  maxAmount: SpendLimit;
  allowedPayTo?: readonly string[];
  /** Refuse sessions of the other mode (e.g. `true` for a mainnet agent). */
  livemode?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface PreparedCheckoutPayment {
  sessionId: string;
  attemptId: string;
  livemode: boolean;
  /** The requirement exactly as sentinel attested it. */
  requirement: IntentsRequirement;
  attestation: SignedAttestation;
  /** The attested merchant (show this, not the session's unverified display name). */
  merchant: { name: string; kyb_verified: boolean };
  /** Destination fingerprint, the same one the merchant sees in the dashboard. */
  fingerprint: string;
  signed: MultiPayload;
}

/** Steps 1–3 plus signing; nothing is submitted. Throws `AgentSignerError` on any refusal. */
export async function prepareCheckoutPayment(
  target: CheckoutTarget,
  signer: IntentSigner,
  opts: CheckoutPaymentOptions,
): Promise<PreparedCheckoutPayment> {
  const pinnedKeys = opts.pinnedKeys ?? PINNED_SENTINEL_KEYS;
  if (pinnedKeys.length === 0) {
    throw new AgentSignerError("no_pinned_keys", "no sentinel key is pinned: checkout payments cannot be verified");
  }
  const ref = resolveTarget(target);
  const http = {
    base: ref.apiBase,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };

  const req = (
    await callRoute(agentPayRequirements, {
      ...http,
      params: { id: ref.sessionId },
      headers: { [HEADERS.clientSecret]: ref.clientSecret },
      body: { payer: signer.signerId },
    })
  ).data as z.output<typeof AgentPayRequirements>;
  if (opts.livemode !== undefined && req.livemode !== opts.livemode) {
    throw new AgentSignerError(
      "invalid_requirements",
      `session is in ${req.livemode ? "live" : "test"} mode; this agent pays ${opts.livemode ? "live" : "test"} only`,
    );
  }
  enforceSpendPolicy(transferTerms(req.requirement), {
    maxAmount: opts.maxAmount,
    ...(opts.allowedPayTo ? { allowedPayTo: opts.allowedPayTo } : {}),
  });

  let raw: unknown;
  try {
    raw = (
      await callRoute(createDepositInstructionsAttestation, {
        ...http,
        body: {
          livemode: req.livemode,
          kind: "intents_transfer",
          attempt_id: req.attempt_id,
          attestation_ticket: req.attestation_ticket,
          requirement: req.requirement,
        },
      })
    ).json;
  } catch (e) {
    if (e instanceof ApiCallError) {
      throw new AgentSignerError("attestation_unavailable", `sentinel did not attest the requirement: ${e.message}`, {
        status: e.status,
        ...(e.apiCode ? { apiCode: e.apiCode } : {}),
      });
    }
    throw e;
  }
  const check = verifyAttestation(
    raw,
    { kind: "intents_transfer", attemptId: req.attempt_id, livemode: req.livemode, requirement: req.requirement },
    { pinnedKeys, now: (opts.now ?? Date.now)() },
  );
  if (!check.ok) {
    throw new AgentSignerError("attestation_invalid", `refusing to sign: ${check.reason} (${check.detail})`);
  }
  const requirement = check.attestation.requirement as IntentsRequirement;
  const signed = await buildTransferPayment(requirement, signer, opts);
  return {
    sessionId: ref.sessionId,
    attemptId: req.attempt_id,
    livemode: req.livemode,
    requirement,
    attestation: raw as SignedAttestation,
    merchant: check.attestation.merchant,
    fingerprint: check.attestation.destination.fingerprint,
    signed,
  };
}

export interface CheckoutPaymentResult {
  prepared: PreparedCheckoutPayment;
  /** `agent_pay_submission`: the payload was queued for relay; success arrives via the session. */
  submission: CheckoutSubmission;
}

export type CheckoutSubmission = {
  status: "submitted";
  agent_payment: string;
  attempt: { id: string; status: string };
};

type HttpOptions = Pick<CheckoutPaymentOptions, "fetch" | "timeoutMs">;

const httpOf = (ref: CheckoutSessionRef, o: HttpOptions) => ({
  base: ref.apiBase,
  ...(o.fetch ? { fetch: o.fetch } : {}),
  ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
});

/**
 * Submits a prepared payment (`POST …/agent_pay {signed}`). A thrown `ApiCallError` with a 4xx status
 * means agentpay refused it before queueing anything (lld/agentpay.md §5); status 0 or 5xx leaves the
 * outcome unknown (the payload may have been queued).
 */
export async function submitCheckoutPayment(
  target: CheckoutTarget,
  prepared: PreparedCheckoutPayment,
  opts: HttpOptions = {},
): Promise<CheckoutSubmission> {
  const ref = resolveTarget(target);
  if (ref.sessionId !== prepared.sessionId) {
    throw new AgentSignerError("invalid_requirements", "prepared payment belongs to another session");
  }
  return (
    await callRoute(agentPay, {
      ...httpOf(ref, opts),
      params: { id: ref.sessionId },
      headers: { [HEADERS.clientSecret]: ref.clientSecret },
      body: { signed: prepared.signed },
    })
  ).data as CheckoutSubmission;
}

/** Prepares (verified + signed) and submits an agent payment for a checkout session. */
export async function payCheckoutSession(
  target: CheckoutTarget,
  signer: IntentSigner,
  opts: CheckoutPaymentOptions,
): Promise<CheckoutPaymentResult> {
  const ref = resolveTarget(target);
  const prepared = await prepareCheckoutPayment(ref, signer, opts);
  const submission = await submitCheckoutPayment(ref, prepared, opts);
  return { prepared, submission };
}

export type PublicCheckoutSessionT = z.output<typeof PublicCheckoutSession>;

/** Session states after which nothing more happens to the agent's payment. */
export function isCheckoutOutcomeFinal(s: PublicCheckoutSessionT): boolean {
  const attempt = s.attempt?.status;
  return (
    s.status === "complete" ||
    s.status === "expired" ||
    ["succeeded", "canceled", "expired", "requires_review"].includes(s.intent_status) ||
    (attempt !== undefined && ["succeeded", "refunded", "failed", "expired_unpaid"].includes(attempt))
  );
}

export interface WaitForCheckoutOptions extends HttpOptions {
  /** Give up after this long (default 60 s); the session is returned as last seen. */
  waitMs?: number;
  /** Poll interval (default 2 s). */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Reads the session as the payer sees it until the payment reaches a final state or `waitMs` passes
 * (`getPublicCheckoutSession`). Reading never changes anything.
 */
export async function waitForCheckoutOutcome(
  target: CheckoutTarget,
  opts: WaitForCheckoutOptions = {},
): Promise<{ session: PublicCheckoutSessionT; final: boolean }> {
  const ref = resolveTarget(target);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + (opts.waitMs ?? 60_000);
  for (;;) {
    const session = (
      await callRoute(getPublicCheckoutSession, {
        ...httpOf(ref, opts),
        params: { id: ref.sessionId },
        headers: { [HEADERS.clientSecret]: ref.clientSecret },
      })
    ).data as PublicCheckoutSessionT;
    const final = isCheckoutOutcomeFinal(session);
    if (final || now() >= until) return { session, final };
    await sleep(Math.min(opts.pollMs ?? 2_000, Math.max(0, until - now())));
  }
}
