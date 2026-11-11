/**
 * Builds the signed NEAR Intents transfer a NearPay requirement asks for (lld/agentpay.md §3,
 * foundations §14): exactly two `transfer` intents in order — the merchant (`payTo`, amount) and the
 * NearPay fee (`fee.to`, fee amount) — both with `memo = binding`, signed for `intents.near`.
 */
import {
  INTENTS_CONTRACT,
  type IntentMessage,
  IntentsRequirement,
  type IntentsRequirement as IntentsRequirementT,
  type MultiPayload,
  PaymentRequirements,
  type PaymentRequirements as PaymentRequirementsT,
  type TransferIntent,
} from "@nearpay-money/spec";
import { fromHex, toBase64 } from "./encoding.js";
import { AgentSignerError } from "./errors.js";
import { rpcSaltProvider, type SaltProvider } from "./salt.js";
import type { IntentSigner } from "./signers.js";

/** An x402 `accepts[]` entry (`exact` + `intents-transfer`) or a checkout IntentsRequirement. */
export type TransferRequirements = PaymentRequirementsT | IntentsRequirementT;

/** What gets signed, whatever the requirement's origin. */
export interface TransferTerms {
  payTo: string;
  asset: string;
  amount: string;
  feeTo: string;
  feeAmount: string;
  binding: string;
  /** Latest deadline the requirement allows (ISO 8601). */
  latestDeadline: string;
  /** Where the requirement came from. */
  kind: "x402" | "checkout";
}

export interface BuildTransferOptions {
  /** Verifier salt source; default: `current_salt` over NEAR RPC, cached 60 s. */
  nonceSaltProvider?: SaltProvider;
  /** 28 random nonce bytes (default: `crypto.getRandomValues`). */
  randomBytes?: (n: number) => Uint8Array;
  /** Payload deadline; must lie in (now, latest allowed]. Default: see {@link transferTerms}. */
  deadline?: string | Date;
  now?: () => number;
}

let defaultSalt: SaltProvider | null = null;

/**
 * Fallback deadline window of an x402 payload, for requirements without `extra.deadline` (facilitators
 * older than spec 0.1.5): only `maxTimeoutSeconds` from issue is known (agentpay §3: deadline ≤
 * issued_at + maxTimeoutSeconds). Half the window leaves room for the 402 round trip and clock skew
 * while staying above the facilitator's 5 s floor (window ≥ 30 s).
 */
export function x402DeadlineSeconds(maxTimeoutSeconds: number): number {
  return Math.floor(maxTimeoutSeconds / 2);
}

/**
 * Latest Verifier deadline an x402 requirement allows: its absolute expiry `extra.deadline` (spec 0.1.5,
 * the binding's `expires_at`) when present, signed as is (at or before it, independent of this clock);
 * otherwise `now + x402DeadlineSeconds(maxTimeoutSeconds)`.
 */
export function x402LatestDeadline(r: PaymentRequirementsT, now: number = Date.now()): string {
  const abs = r.extra.deadline;
  if (abs !== undefined) {
    // Date keeps milliseconds: a finer RFC 3339 fraction is truncated, so the result never exceeds it.
    const t = Date.parse(abs);
    if (!Number.isFinite(t)) throw new AgentSignerError("invalid_requirements", `extra.deadline is not a time: ${abs}`);
    return new Date(t).toISOString();
  }
  return new Date(now + x402DeadlineSeconds(r.maxTimeoutSeconds) * 1000).toISOString();
}

/** Validates a requirement and returns the transfer it asks for. */
export function transferTerms(req: TransferRequirements, now: number = Date.now()): TransferTerms {
  if (req && typeof req === "object" && "extra" in req) {
    const p = PaymentRequirements.safeParse(req);
    if (!p.success) {
      throw new AgentSignerError(
        "invalid_requirements",
        `not a NearPay intents-transfer requirement: ${issue(p.error)}`,
      );
    }
    const r = p.data;
    return check({
      kind: "x402",
      payTo: r.payTo,
      asset: r.asset,
      amount: r.amount,
      feeTo: r.extra.fee.to,
      feeAmount: r.extra.fee.amount,
      binding: r.extra.binding,
      latestDeadline: x402LatestDeadline(r, now),
    });
  }
  const p = IntentsRequirement.safeParse(req);
  if (!p.success) throw new AgentSignerError("invalid_requirements", `not an IntentsRequirement: ${issue(p.error)}`);
  const r = p.data;
  return check({
    kind: "checkout",
    payTo: r.pay_to,
    asset: r.token,
    amount: r.amount,
    feeTo: r.fee_to,
    feeAmount: r.fee_amount,
    binding: r.binding,
    latestDeadline: new Date(r.deadline).toISOString(),
  });
}

function issue(e: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join(".") || "(root)"}: ${i.message}` : "invalid";
}

function check(t: TransferTerms): TransferTerms {
  if (BigInt(t.amount) <= 0n) throw new AgentSignerError("invalid_requirements", "amount must be positive");
  return t;
}

/** The two transfers, in the order and key order the Verifier message carries them. */
export function transferIntents(t: TransferTerms): [TransferIntent, TransferIntent] {
  return [
    { intent: "transfer", receiver_id: t.payTo, tokens: { [t.asset]: t.amount }, memo: t.binding },
    { intent: "transfer", receiver_id: t.feeTo, tokens: { [t.asset]: t.feeAmount }, memo: t.binding },
  ];
}

/** 32-byte nonce: salt ‖ 28 random bytes, standard base64. */
export function makeNonce(saltHex: string, randomBytes?: (n: number) => Uint8Array): string {
  if (!/^[0-9a-f]{8}$/.test(saltHex)) throw new AgentSignerError("salt_unavailable", "salt must be 8 hex characters");
  const r = randomBytes ? randomBytes(28) : crypto.getRandomValues(new Uint8Array(28));
  if (r.length !== 28) throw new RangeError("randomBytes must return 28 bytes");
  const nonce = new Uint8Array(32);
  nonce.set(fromHex(saltHex), 0);
  nonce.set(r, 4);
  return toBase64(nonce);
}

/** Builds (without signing) the Verifier message for a requirement. */
export async function buildTransferMessage(
  req: TransferRequirements,
  signerId: string,
  opts: BuildTransferOptions = {},
): Promise<IntentMessage> {
  const now = (opts.now ?? Date.now)();
  const terms = transferTerms(req, now);
  const latest = Date.parse(terms.latestDeadline);
  let deadline = terms.latestDeadline;
  if (opts.deadline !== undefined) {
    const d = typeof opts.deadline === "string" ? Date.parse(opts.deadline) : opts.deadline.getTime();
    if (!Number.isFinite(d) || d <= now || d > latest) {
      throw new AgentSignerError(
        "invalid_requirements",
        `deadline must be after now and at most ${terms.latestDeadline}`,
      );
    }
    deadline = new Date(d).toISOString();
  }
  if (latest <= now) throw new AgentSignerError("invalid_requirements", "the requirement's deadline has passed");
  defaultSalt ??= rpcSaltProvider();
  const salt = await (opts.nonceSaltProvider ?? defaultSalt)();
  return {
    signer_id: signerId,
    verifying_contract: INTENTS_CONTRACT,
    deadline,
    nonce: makeNonce(salt, opts.randomBytes),
    intents: transferIntents(terms),
  };
}

/**
 * Signs the transfer a requirement asks for and returns the `MultiPayload`. x402 requirements come
 * from the merchant's own server and are signed as received (spend limits are the caller's job, see
 * `withX402`); checkout requirements must be sentinel-verified first — use `payCheckoutSession`.
 */
export async function buildTransferPayment(
  req: TransferRequirements,
  signer: IntentSigner,
  opts: BuildTransferOptions = {},
): Promise<MultiPayload> {
  return signer.sign(await buildTransferMessage(req, signer.signerId, opts));
}
