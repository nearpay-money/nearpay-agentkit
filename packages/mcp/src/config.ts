/**
 * Configuration of the NearPay MCP server. Programmatic callers build `NearPayMcpOptions` directly; the
 * `nearpay-mcp` binary reads it from the environment (`optionsFromEnv`). Fail closed: payer tools exist
 * only with a signer **and** a non-empty pay-to allow-list; limits default to small stablecoin amounts
 * and every other asset is refused until configured.
 */
import { readFile } from "node:fs/promises";
import {
  type BudgetLimits,
  type IntentSigner,
  type IntentsBalanceProvider,
  nearSigner,
  type PinnedSentinelKey,
  parsePinnedKeys,
  rpcIntentsBalanceProvider,
  rpcSaltProvider,
  type SaltProvider,
  SpendingBudget,
  type SpendLimit,
  staticSaltProvider,
} from "@nearpay-money/agent-signer";
import type { OperationStore, OriginSigner } from "@nearpay-money/x402";
import type { Logger } from "./redact.js";

/** Well-known 6-decimal stablecoins (NEAR Intents ids), the only assets allowed by default. */
export const STABLECOINS = Object.freeze({
  "usdc.near": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "usdt.near": "nep141:usdt.tether-token.near",
  "usdc.base": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "usdc.arb": "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  "usdc.eth": "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
});

const each = (v: string) => Object.fromEntries(Object.values(STABLECOINS).map((a) => [a, v]));

/** Conservative defaults: 1.00 per payment, 10.00 per session, stablecoins only. */
export const DEFAULT_LIMITS: BudgetLimits = Object.freeze({
  perCall: Object.freeze(each("1000000")),
  perSession: Object.freeze(each("10000000")),
});

export const DEFAULT_API_BASE = "https://api.nearpay.money";
export const DEFAULT_PAYMENT_HOSTS: readonly string[] = ["pay.nearpay.money"];

export interface CrossChainConfig {
  originSigner: OriginSigner;
  /** Origin assets (NEAR Intents ids) allowed, in preference order. */
  origins?: readonly string[];
  slippageBps?: number;
  /** Intents balance reader (prefers intents-transfer when it covers the price). */
  balance?: IntentsBalanceProvider;
}

export interface PayerConfig {
  /** NEP-413 signer of the agent's NEAR Intents account (the operator's local key). */
  signer: IntentSigner;
  /** Merchant NEAR Intents accounts the agent may pay (required, non-empty). */
  allowedPayTo: readonly string[];
  limits?: BudgetLimits;
  /** Sentinel keys pinned out of band; without them checkout and invoice payments are refused. */
  pinnedKeys?: readonly PinnedSentinelKey[];
  /** Hosts whose checkout (`/c/`) and invoice (`/i/`) URLs may be paid (default `pay.nearpay.money`). */
  paymentHosts?: readonly string[];
  /** API base of the payer routes (default `<checkout origin>/api`). */
  payApiBase?: string;
  nonceSaltProvider?: SaltProvider;
  /** Cross-chain operation store (default: in memory, lost on exit). */
  store?: OperationStore;
  crossChain?: CrossChainConfig;
  /** How long a checkout payment waits for its final state (default 30 s). */
  checkoutWaitMs?: number;
  /** How long a cross-chain fetch waits for settlement before answering `pending` (default 120 s). */
  fetchWaitMs?: number;
  /** Largest response body returned by `nearpay_fetch_paid` (default 64 KiB). */
  maxResponseBytes?: number;
  /** Allow `http://` resources (default: only in test mode, only for localhost). */
  allowHttp?: boolean;
}

export interface NearPayMcpOptions {
  /** Live mode (real funds) or test mode (sandbox); payments of the other mode are refused. */
  livemode: boolean;
  /** NearPay API origin for merchant tools. */
  apiBase?: string;
  /** Merchant secret (`sk_…`) or restricted (`rk_…`) key: enables the merchant tools. */
  merchantApiKey?: string;
  /** Enables the payer tools. */
  payer?: PayerConfig;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Extra literals masked in logs and results (keys, tokens). */
  secrets?: readonly string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Throws `ConfigError` on an unsafe or inconsistent configuration. */
export function validateOptions(o: NearPayMcpOptions): void {
  if (!o.merchantApiKey && !o.payer) throw new ConfigError("configure a merchant API key, a payer signer, or both");
  if (o.merchantApiKey) {
    const m = /^(sk|rk)_(live|test)_[0-9A-Za-z]+$/.exec(o.merchantApiKey);
    if (!m) throw new ConfigError("the merchant API key must be a NearPay sk_… or rk_… key");
    if ((m[2] === "live") !== o.livemode) {
      throw new ConfigError(
        `the merchant API key is a ${m[2]} key but the server runs in ${o.livemode ? "live" : "test"} mode`,
      );
    }
  }
  const p = o.payer;
  if (p) {
    if (p.allowedPayTo.length === 0) {
      throw new ConfigError("payer tools need an explicit allow-list of merchant Intents accounts (allowedPayTo)");
    }
    new SpendingBudget(p.limits ?? DEFAULT_LIMITS); // validates the limits
    for (const h of p.paymentHosts ?? DEFAULT_PAYMENT_HOSTS) {
      if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/.test(h)) throw new ConfigError(`payment host ${h} is not a host name`);
    }
    if (o.livemode && p.allowHttp) throw new ConfigError("allowHttp is only available in test mode");
  }
}

// ---------------------------------------------------------------------------------------------
// Environment (nearpay-mcp binary)
// ---------------------------------------------------------------------------------------------

export type Env = Readonly<Record<string, string | undefined>>;

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

async function secret(env: Env, name: string): Promise<string | undefined> {
  const file = env[`${name}_FILE`];
  if (file) return (await readFile(file, "utf8")).trim();
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function bool(v: string | undefined, name: string, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new ConfigError(`${name} must be true or false`);
}

function json<T>(v: string, name: string): T {
  try {
    return JSON.parse(v) as T;
  } catch {
    throw new ConfigError(`${name} must be JSON`);
  }
}

/** Limits JSON: `{"perCall": <limit>, "perSession": <limit>}`, a limit = base units or `{asset: base units}`. */
export function parseLimits(v: string): BudgetLimits {
  const o = json<{ perCall?: SpendLimit; perSession?: SpendLimit }>(v, "NEARPAY_MCP_LIMITS");
  if (!o || typeof o !== "object" || o.perCall === undefined || o.perSession === undefined) {
    throw new ConfigError("NEARPAY_MCP_LIMITS needs perCall and perSession");
  }
  try {
    new SpendingBudget({ perCall: o.perCall, perSession: o.perSession });
  } catch (e) {
    throw new ConfigError(`NEARPAY_MCP_LIMITS: ${(e as Error).message}`);
  }
  return { perCall: o.perCall, perSession: o.perSession };
}

/**
 * NEAR key material: a NEAR CLI credentials JSON (`{account_id, private_key}`) or a bare
 * `ed25519:<base58>` secret key.
 */
export function parseNearKey(text: string): { accountId?: string; secretKey: string } {
  const t = text.trim();
  if (t.startsWith("{")) {
    const o = json<{ account_id?: unknown; private_key?: unknown; secret_key?: unknown }>(t, "NEAR key file");
    const key = o.private_key ?? o.secret_key;
    if (typeof key !== "string") throw new ConfigError("NEAR key file has no private_key");
    return { ...(typeof o.account_id === "string" ? { accountId: o.account_id } : {}), secretKey: key };
  }
  return { secretKey: t };
}

export interface EnvOptions {
  options: NearPayMcpOptions;
  http: { host: string; port: number; token?: string; allowedHosts: string[] };
  /** Cross-chain settings; the binary adds the origin signer (EVM via viem) when one is configured. */
  crossChain?: Omit<CrossChainConfig, "originSigner">;
  /** EVM origin settings for the binary (built with viem when present). */
  evm?: { privateKey: string; rpcUrls: Record<string, string>; nativeAssets?: Record<string, string> };
}

/** Reads the binary's configuration. Secrets may come from `<NAME>_FILE` files. */
export async function optionsFromEnv(env: Env): Promise<EnvOptions> {
  const livemode = bool(env.NEARPAY_MCP_LIVEMODE, "NEARPAY_MCP_LIVEMODE", false);
  const secrets: string[] = [];
  const merchantApiKey = await secret(env, "NEARPAY_API_KEY");
  if (merchantApiKey) secrets.push(merchantApiKey);

  let payer: PayerConfig | undefined;
  const keyText = await secret(env, "NEARPAY_MCP_NEAR_PRIVATE_KEY");
  if (keyText) {
    const key = parseNearKey(keyText);
    secrets.push(key.secretKey);
    const accountId = env.NEARPAY_MCP_NEAR_ACCOUNT_ID ?? key.accountId;
    let signer: IntentSigner;
    try {
      signer = nearSigner({ keyPair: key.secretKey, ...(accountId ? { accountId } : {}) });
    } catch (e) {
      throw new ConfigError(`NEAR key: ${(e as Error).message}`);
    }
    const rpcUrls = list(env.NEARPAY_MCP_NEAR_RPC_URLS);
    const keysFile = env.NEARPAY_MCP_SENTINEL_KEYS_FILE;
    payer = {
      signer,
      allowedPayTo: list(env.NEARPAY_MCP_ALLOWED_PAY_TO),
      ...(env.NEARPAY_MCP_LIMITS ? { limits: parseLimits(env.NEARPAY_MCP_LIMITS) } : {}),
      ...(keysFile ? { pinnedKeys: parsePinnedKeys(await readFile(keysFile, "utf8")) } : {}),
      ...(env.NEARPAY_MCP_PAYMENT_HOSTS ? { paymentHosts: list(env.NEARPAY_MCP_PAYMENT_HOSTS) } : {}),
      ...(env.NEARPAY_MCP_PAY_API_BASE ? { payApiBase: env.NEARPAY_MCP_PAY_API_BASE } : {}),
      // Test mode pays the sandbox Verifier, which accepts any salt; live mode reads `current_salt`.
      nonceSaltProvider:
        rpcUrls.length > 0 || livemode
          ? rpcSaltProvider(rpcUrls.length > 0 ? { rpcUrls } : {})
          : staticSaltProvider("00000000"),
      ...(env.NEARPAY_MCP_CHECKOUT_WAIT_MS ? { checkoutWaitMs: Number(env.NEARPAY_MCP_CHECKOUT_WAIT_MS) } : {}),
      ...(env.NEARPAY_MCP_FETCH_WAIT_MS ? { fetchWaitMs: Number(env.NEARPAY_MCP_FETCH_WAIT_MS) } : {}),
      ...(env.NEARPAY_MCP_ALLOW_HTTP
        ? { allowHttp: bool(env.NEARPAY_MCP_ALLOW_HTTP, "NEARPAY_MCP_ALLOW_HTTP", false) }
        : {}),
    };
  }

  const crossChain: EnvOptions["crossChain"] = payer
    ? {
        ...(list(env.NEARPAY_MCP_CROSS_CHAIN_ORIGINS).length > 0
          ? { origins: list(env.NEARPAY_MCP_CROSS_CHAIN_ORIGINS) }
          : {}),
        ...(env.NEARPAY_MCP_SLIPPAGE_BPS ? { slippageBps: Number(env.NEARPAY_MCP_SLIPPAGE_BPS) } : {}),
        ...(livemode || list(env.NEARPAY_MCP_NEAR_RPC_URLS).length > 0
          ? {
              balance: rpcIntentsBalanceProvider(
                list(env.NEARPAY_MCP_NEAR_RPC_URLS).length > 0 ? { rpcUrls: list(env.NEARPAY_MCP_NEAR_RPC_URLS) } : {},
              ),
            }
          : {}),
      }
    : undefined;

  let evm: EnvOptions["evm"];
  const evmKey = await secret(env, "NEARPAY_MCP_EVM_PRIVATE_KEY");
  if (evmKey) {
    secrets.push(evmKey);
    evm = {
      privateKey: evmKey,
      rpcUrls: env.NEARPAY_MCP_EVM_RPC_URLS
        ? json<Record<string, string>>(env.NEARPAY_MCP_EVM_RPC_URLS, "NEARPAY_MCP_EVM_RPC_URLS")
        : {},
      ...(env.NEARPAY_MCP_EVM_NATIVE_ASSETS
        ? {
            nativeAssets: json<Record<string, string>>(
              env.NEARPAY_MCP_EVM_NATIVE_ASSETS,
              "NEARPAY_MCP_EVM_NATIVE_ASSETS",
            ),
          }
        : {}),
    };
  }

  const token = await secret(env, "NEARPAY_MCP_HTTP_TOKEN");
  if (token) secrets.push(token);
  const port = Number(env.NEARPAY_MCP_HTTP_PORT ?? 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new ConfigError("NEARPAY_MCP_HTTP_PORT is not a port");
  const host = env.NEARPAY_MCP_HTTP_HOST ?? "127.0.0.1";
  const options: NearPayMcpOptions = {
    livemode,
    apiBase: env.NEARPAY_API_BASE ?? DEFAULT_API_BASE,
    ...(merchantApiKey ? { merchantApiKey } : {}),
    ...(payer ? { payer } : {}),
    secrets,
  };
  return {
    options,
    http: {
      host,
      port,
      ...(token ? { token } : {}),
      allowedHosts: env.NEARPAY_MCP_HTTP_ALLOWED_HOSTS
        ? list(env.NEARPAY_MCP_HTTP_ALLOWED_HOSTS)
        : [`127.0.0.1:${port}`, `localhost:${port}`],
    },
    ...(evm ? { evm } : {}),
    ...(crossChain ? { crossChain } : {}),
  };
}
