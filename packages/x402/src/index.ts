/**
 * @nearpay/x402 — NearPay's x402 profile (`exact` + `intents-transfer` on `near:mainnet`,
 * lld/agentpay.md §3, and cross-chain `exact` + `near-intents`, §3.1) for merchants and agents
 * (lld/sdks-and-tools.md §2).
 *
 * Merchants: `paywall` (Express), `withPaywall` (fetch handlers / Next.js), `honoPaywall`
 * (`@nearpay/x402/hono`), all built on `createPaywall` (`origins` enables near-intents).
 * Agents: `withX402(fetch, signer, limits)` (`crossChain` enables near-intents deposits).
 */
export {
  type CrossChainOptions,
  checkQuotedEntry,
  decodeNearIntentsPaymentResponse,
  decodePaymentResponse,
  parsePaymentRequired,
  type ResumeOptions,
  resumeX402Operation,
  type WithX402Options,
  withX402,
  X402ClientError,
  type X402ClientErrorCode,
  type X402PaymentEvent,
} from "./client.js";
export {
  type ExpressLikeRequest,
  type ExpressLikeResponse,
  type ExpressNext,
  expressResourceUrl,
  paywall,
} from "./express.js";
export {
  DEFAULT_API_BASE,
  type Facilitator,
  FacilitatorError,
  type FacilitatorOptions,
  facilitator,
  type NearIntentsRequirementsRequest,
  type NearIntentsSettleResponseBody,
  type NearIntentsVerifyRequestBody,
  type NearIntentsVerifyResponseBody,
  type PaymentRequiredAnyBody,
  type PaymentRequiredBody,
  type RequirementsRequest,
  type SettleResponseBody,
  type SupportedResponseBody,
  type VerifyRequestBody,
  type VerifyResponseBody,
} from "./facilitator.js";
export { paymentOf, withPaywall } from "./fetch.js";
export {
  DepositNotSentError,
  type DepositRequest,
  type EvmDepositorOptions,
  type EvmWalletLike,
  erc20TransferData,
  evmDepositor,
  isOperationOpen,
  memoryOperationStore,
  type OperationStore,
  type OriginSigner,
  type X402Operation,
  type X402OperationState,
} from "./origin.js";
export {
  createPaywall,
  type IntentsTransferPaidRequest,
  type NearIntentsPaidRequest,
  type NearIntentsSettleResponseT,
  type PaidRequest,
  type Paywall,
  type PaywallConfig,
  type PaywallOptions,
  type PaywallOrigin,
  type PaywallRequest,
  type PaywallResult,
  paidRequestOf,
} from "./paywall.js";
