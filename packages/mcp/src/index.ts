/**
 * @nearpay-money/mcp — NearPay MCP server for agents (lld/sdks-and-tools.md §2, Stage 3): merchant tools
 * (checkout sessions, payment intents) and payer tools (checkout and invoice payments, x402 incl.
 * cross-chain near-intents) with per-call and per-session limits, a merchant allow-list and evidence links.
 * Run it with `nearpay-mcp` (stdio or `--http`) or embed it with `createNearPayMcpServer`.
 */
export {
  ConfigError,
  type CrossChainConfig,
  DEFAULT_API_BASE,
  DEFAULT_LIMITS,
  DEFAULT_PAYMENT_HOSTS,
  type Env,
  type EnvOptions,
  type NearPayMcpOptions,
  optionsFromEnv,
  type PayerConfig,
  parseLimits,
  parseNearKey,
  STABLECOINS,
  validateOptions,
} from "./config.js";
export { type EvidenceKind, type EvidenceLink, EXPLORER_TX_URLS, explorerTxUrl } from "./evidence.js";
export { type MerchantClient, type MerchantClientOptions, merchantClient, NearPayApiError } from "./merchant.js";
export { type Logger, type LogLevel, redact, stderrLogger } from "./redact.js";
export {
  capLimit,
  createNearPayMcpContext,
  createNearPayMcpServer,
  MERCHANT_TOOLS,
  type NearPayMcpContext,
  PAYER_TOOLS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./server.js";
export { fileOperationStore } from "./store.js";
export { type HttpOptions, startHttp, startStdio } from "./transports.js";
