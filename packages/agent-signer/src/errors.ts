/** Errors raised by `@nearpay/agent-signer`. Every refusal to sign carries a stable `code`. */

export type AgentSignerErrorCode =
  /** The requirement is not a valid x402 `intents-transfer` requirement or IntentsRequirement. */
  | "invalid_requirements"
  /** The signer cannot produce a valid signature for its own account (wrong key, bad wallet output). */
  | "signer_error"
  /** The Verifier nonce salt could not be read. */
  | "salt_unavailable"
  /** No pinned sentinel key is configured, so checkout requirements can never be verified. */
  | "no_pinned_keys"
  /** The sentinel attestation is missing, malformed, unsigned by a pinned key, expired or does not match. */
  | "attestation_invalid"
  /** Sentinel refused or could not attest the requirement (fail closed: nothing is signed). */
  | "attestation_unavailable"
  /** The payment exceeds the caller's spend limit or pays an account that is not allowed. */
  | "spend_limit_exceeded"
  | "pay_to_not_allowed"
  /** The NearPay API answered with an error envelope or an unexpected response. */
  | "api_error";

export class AgentSignerError extends Error {
  constructor(
    readonly code: AgentSignerErrorCode,
    message: string,
    /** API error details when `code` is `api_error` / `attestation_unavailable`. */
    readonly details?: { status?: number; apiCode?: string; requestId?: string },
  ) {
    super(message);
    this.name = "AgentSignerError";
  }
}
