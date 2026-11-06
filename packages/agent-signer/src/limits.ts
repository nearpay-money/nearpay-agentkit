/**
 * Client-side spend limits (lld/sdks-and-tools.md §2): an agent refuses to sign a payment whose total
 * debit (merchant amount + NearPay fee, base units) exceeds its limit, or that pays an account it does
 * not allow. Limits are in base units of the payment asset.
 */
import { AgentSignerError } from "./errors.js";
import type { TransferTerms } from "./payment.js";

export type Amount = bigint | string | number;

/**
 * One limit for every asset, or a limit per asset id (assets without an entry are refused). A single
 * number applies to base units of whatever asset is requested: prefer the per-asset form when the
 * agent may meet assets with different decimals.
 */
export type SpendLimit = Amount | Readonly<Record<string, Amount>>;

export interface SpendPolicy {
  maxAmount: SpendLimit;
  allowedPayTo?: readonly string[];
}

function toBig(a: Amount, what: string): bigint {
  if (typeof a === "number" && !Number.isSafeInteger(a)) throw new RangeError(`${what} must be an integer`);
  if (typeof a === "string" && !/^(0|[1-9][0-9]*)$/.test(a)) throw new RangeError(`${what} must be base units`);
  const v = BigInt(a);
  if (v < 0n) throw new RangeError(`${what} must not be negative`);
  return v;
}

/** The limit that applies to `asset`, or null when the asset is not allowed at all. */
export function limitFor(limit: SpendLimit, asset: string): bigint | null {
  if (typeof limit === "object") {
    const v = Object.hasOwn(limit, asset) ? limit[asset] : undefined;
    return v === undefined ? null : toBig(v, `limit for ${asset}`);
  }
  return toBig(limit, "limit");
}

/** Throws unless the payment is within the policy. Returns the total debit. */
export function enforceSpendPolicy(terms: TransferTerms, policy: SpendPolicy): bigint {
  if (policy.allowedPayTo && !policy.allowedPayTo.includes(terms.payTo)) {
    throw new AgentSignerError("pay_to_not_allowed", `paying ${terms.payTo} is not allowed by this agent's policy`);
  }
  const total = BigInt(terms.amount) + BigInt(terms.feeAmount);
  const max = limitFor(policy.maxAmount, terms.asset);
  if (max === null) {
    throw new AgentSignerError("spend_limit_exceeded", `asset ${terms.asset} is not in this agent's spend limits`);
  }
  if (total > max) {
    throw new AgentSignerError(
      "spend_limit_exceeded",
      `payment of ${total} (amount ${terms.amount} + fee ${terms.feeAmount}) exceeds the limit ${max} of ${terms.asset}`,
    );
  }
  return total;
}
