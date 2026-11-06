/**
 * @nearpay/agent-signer — signing NearPay NEAR Intents transfers for agents (lld/sdks-and-tools.md §2).
 *
 * - `nearSigner` (NEP-413 / raw Ed25519) and `evmSigner` (ERC-191) produce Verifier `MultiPayload`s
 *   byte-identical to `nearpay-spec/test-vectors/intents-payloads.json`.
 * - `buildTransferPayment(requirements, signer, {nonceSaltProvider})` signs exactly the two transfers
 *   a requirement asks for (merchant + NearPay fee, memo = binding).
 * - `payCheckoutSession` pays a checkout session only after verifying sentinel's co-signature with
 *   pinned keys; it refuses on any mismatch.
 */
export {
  type AttestationCheck,
  type AttestationFailure,
  type ExpectedAttestation,
  PINNED_SENTINEL_KEYS,
  type PinnedSentinelKey,
  parsePinnedKeys,
  type VerifyAttestationOptions,
  verifyAttestation,
} from "./attestation.js";
export {
  type CheckoutPaymentOptions,
  type CheckoutPaymentResult,
  type CheckoutSessionRef,
  type CheckoutTarget,
  type PreparedCheckoutPayment,
  parseCheckoutUrl,
  payCheckoutSession,
  prepareCheckoutPayment,
} from "./checkout.js";
export { nep413Hash } from "./encoding.js";
export { AgentSignerError, type AgentSignerErrorCode } from "./errors.js";
export { ApiCallError } from "./http.js";
export { type Amount, enforceSpendPolicy, limitFor, type SpendLimit, type SpendPolicy } from "./limits.js";
export {
  type BuildTransferOptions,
  buildTransferMessage,
  buildTransferPayment,
  makeNonce,
  type TransferRequirements,
  type TransferTerms,
  transferIntents,
  transferTerms,
  x402DeadlineSeconds,
  x402LatestDeadline,
} from "./payment.js";
export {
  DEFAULT_NEAR_RPC_URLS,
  type RpcSaltProviderOptions,
  rpcSaltProvider,
  type SaltProvider,
  staticSaltProvider,
} from "./salt.js";
export {
  type EvmAccount,
  evmSigner,
  type IntentSigner,
  type NearKeyPair,
  type NearSignerOptions,
  nearSigner,
  type SignatureStandard,
} from "./signers.js";
