/**
 * @nearpay/x402 — NearPay's x402 profile (`exact` + `intents-transfer` on `near:mainnet`,
 * lld/agentpay.md §3) for merchants and agents (lld/sdks-and-tools.md §2).
 *
 * Merchants: `paywall` (Express), `withPaywall` (fetch handlers / Next.js), `honoPaywall`
 * (`@nearpay/x402/hono`), all built on `createPaywall`. Agents: `withX402(fetch, signer, limits)`.
 */
export {
  decodePaymentResponse,
  parsePaymentRequired,
  type WithX402Options,
  withX402,
  X402ClientError,
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
  type PaymentRequiredBody,
  type RequirementsRequest,
  type SettleResponseBody,
  type SupportedResponseBody,
  type VerifyRequestBody,
  type VerifyResponseBody,
} from "./facilitator.js";
export { paymentOf, withPaywall } from "./fetch.js";
export {
  createPaywall,
  type PaidRequest,
  type Paywall,
  type PaywallConfig,
  type PaywallOptions,
  type PaywallRequest,
  type PaywallResult,
} from "./paywall.js";
