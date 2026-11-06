/**
 * Sentinel co-signature verification (FR-PAY-10, system audit S-05, lld/sentinel.md §5–§6): the agent
 * releases a checkout payment only when sentinel — an independent party — signed exactly the
 * requirement it is about to sign. Same rules as the hosted checkout (checkout §5 rule 2):
 * Ed25519 over the RFC 8785 canonical JSON of `attestation`, a pinned key whose `kid` is allow-listed,
 * and every attested field equal to what will be signed. Keys are never fetched from the API.
 */
import { type Attestation, type IntentsRequirement, SignedAttestation } from "@nearpay/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import canonicalize from "canonicalize";
import { fromBase64Url, utf8 } from "./encoding.js";
import { AgentSignerError } from "./errors.js";

/** A sentinel public key pinned out of band (`.secrets/public/sentinel_keys.json` format). */
export interface PinnedSentinelKey {
  /** Key id; also the allow-list entry. */
  kid: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  public_key: string;
  /** Retirement time (ISO 8601); attestations are refused after it. */
  not_after?: string | null;
}

/**
 * Sentinel keys shipped with this package (the production key ids). Empty in 0.1.x: in Stages 1–4
 * sentinel runs in the operator's own Compose stack with a locally generated key, which the operator
 * pins with the `pinnedKeys` option (read from `.secrets/public/sentinel_keys.json`, never from the
 * API). With no pinned key at all, every checkout payment is refused.
 */
export const PINNED_SENTINEL_KEYS: readonly PinnedSentinelKey[] = Object.freeze([]);

const KID_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Parses pinned keys: an array `[{kid, public_key, not_after?}]` (the `sentinel_keys.json` written by
 * `nearpay-deploy/scripts/seed.sh keys`) or `{keys: [...]}`. Throws on anything malformed.
 */
export function parsePinnedKeys(input: unknown): PinnedSentinelKey[] {
  const value = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { keys?: unknown }).keys)
      ? (value as { keys: unknown[] }).keys
      : null;
  if (!list) throw new AgentSignerError("no_pinned_keys", "pinned keys must be an array of {kid, public_key}");
  return list.map((k, i) => {
    const e = (why: string) => new AgentSignerError("no_pinned_keys", `pinned key ${i}: ${why}`);
    if (!k || typeof k !== "object") throw e("not an object");
    const { kid, public_key, not_after } = k as Record<string, unknown>;
    if (typeof kid !== "string" || !KID_RE.test(kid)) throw e("kid must match [a-z0-9-]{1,64}");
    if (typeof public_key !== "string") throw e("public_key must be base64url");
    let raw: Uint8Array;
    try {
      raw = fromBase64Url(public_key);
    } catch {
      throw e("public_key must be base64url");
    }
    if (raw.length !== 32) throw e("public_key must be 32 bytes");
    if (
      not_after !== undefined &&
      not_after !== null &&
      (typeof not_after !== "string" || !Number.isFinite(Date.parse(not_after)))
    ) {
      throw e("not_after must be an ISO 8601 time");
    }
    return { kid, public_key, ...(typeof not_after === "string" ? { not_after } : {}) };
  });
}

/** What the agent is about to act on; the attestation must say exactly this. */
export type ExpectedAttestation =
  | { kind: "intents_transfer"; attemptId: string; livemode: boolean; requirement: IntentsRequirement }
  | {
      kind: "route_quote";
      attemptId: string;
      livemode: boolean;
      deposit: {
        address: string;
        memo: string | null;
        chain: string;
        origin_asset_id: string;
        amount_in: string;
        deadline: string;
      };
    };

export type AttestationFailure = "malformed" | "unknown_kid" | "key_retired" | "bad_signature" | "mismatch" | "expired";

export type AttestationCheck =
  | { ok: true; attestation: Attestation; kid: string }
  | { ok: false; reason: AttestationFailure; detail: string };

export interface VerifyAttestationOptions {
  pinnedKeys: readonly PinnedSentinelKey[];
  now?: number;
}

const sameInstant = (a: string, b: string) => {
  const x = Date.parse(a);
  return Number.isFinite(x) && x === Date.parse(b);
};

function canonical(v: unknown): string {
  const s = canonicalize(v);
  if (s === undefined) throw new Error("not canonicalizable");
  return s;
}

/** Verifies a sentinel co-signature against pinned keys and the expected terms. Never throws. */
export function verifyAttestation(
  signed: unknown,
  expected: ExpectedAttestation,
  opts: VerifyAttestationOptions,
): AttestationCheck {
  const fail = (reason: AttestationFailure, detail: string): AttestationCheck => ({ ok: false, reason, detail });
  const parsed = SignedAttestation.safeParse(signed);
  if (!parsed.success) return fail("malformed", parsed.error.issues[0]?.message ?? "not a signed attestation");
  const { attestation: a, kid, signature } = parsed.data;
  const now = opts.now ?? Date.now();

  const key = opts.pinnedKeys.find((k) => k.kid === kid);
  if (!key) return fail("unknown_kid", `kid ${kid} is not pinned`);
  if (key.not_after && now > Date.parse(key.not_after))
    return fail("key_retired", `key ${kid} retired at ${key.not_after}`);
  try {
    // The signature covers the attestation exactly as sentinel sent it (unknown fields included).
    const raw = (signed as { attestation: unknown }).attestation;
    const sig = fromBase64Url(signature);
    const pk = fromBase64Url(key.public_key);
    if (sig.length !== 64 || pk.length !== 32 || !ed25519.verify(sig, utf8(canonical(raw)), pk)) {
      return fail("bad_signature", "signature does not verify with the pinned key");
    }
  } catch (e) {
    return fail("bad_signature", (e as Error).message);
  }

  const mismatch = (field: string) => fail("mismatch", `attested ${field} differs from the payment`);
  if (a.v !== 1) return mismatch("version");
  if (a.kind !== expected.kind) return mismatch("kind");
  if (a.attempt_id !== expected.attemptId) return mismatch("attempt_id");
  if (a.livemode !== expected.livemode) return mismatch("livemode");
  if (expected.kind === "intents_transfer") {
    const r = a.requirement;
    const e = expected.requirement;
    if (!r || a.deposit) return mismatch("requirement");
    for (const f of ["pay_to", "token", "amount", "fee_to", "fee_amount", "binding"] as const) {
      if (r[f] !== e[f]) return mismatch(`requirement.${f}`);
    }
    if (!sameInstant(r.deadline, e.deadline)) return mismatch("requirement.deadline");
    if (a.destination.asset_id !== e.token) return mismatch("destination.asset_id");
  } else {
    const d = a.deposit;
    const e = expected.deposit;
    if (!d || a.requirement) return mismatch("deposit");
    for (const f of ["address", "memo", "chain", "origin_asset_id", "amount_in"] as const) {
      if (d[f] !== e[f]) return mismatch(`deposit.${f}`);
    }
    if (!sameInstant(d.deadline, e.deadline)) return mismatch("deposit.deadline");
  }
  if (!(Date.parse(a.expires_at) > now)) return fail("expired", `attestation expired at ${a.expires_at}`);
  return { ok: true, attestation: a, kid };
}
