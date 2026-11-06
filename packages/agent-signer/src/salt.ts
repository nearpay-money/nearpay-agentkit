/**
 * Verifier nonce salt (foundations §14): nonce = 4-byte `current_salt` of `intents.near` ‖ 28 random
 * bytes. The default provider reads `current_salt` over NEAR JSON-RPC and caches it for 60 s.
 */
import { INTENTS_CONTRACT } from "@nearpay/spec";
import { toBase64 } from "./encoding.js";
import { AgentSignerError } from "./errors.js";

/** Returns the current salt as 8 lower-case hex characters. */
export type SaltProvider = () => Promise<string>;

export const DEFAULT_NEAR_RPC_URLS: readonly string[] = [
  "https://free.rpc.fastnear.com",
  "https://rpc.mainnet.near.org",
];

const SALT_RE = /^[0-9a-f]{8}$/;

function checkSalt(s: unknown): string {
  if (typeof s !== "string" || !SALT_RE.test(s)) {
    throw new AgentSignerError("salt_unavailable", `current_salt must be 4 bytes of lower-case hex, got ${String(s)}`);
  }
  return s;
}

/** A fixed salt (tests; the sandbox Verifier accepts any salt). */
export function staticSaltProvider(saltHex: string): SaltProvider {
  const salt = checkSalt(saltHex);
  return async () => salt;
}

export interface RpcSaltProviderOptions {
  rpcUrls?: readonly string[];
  contract?: string;
  /** Cache lifetime (default 60 s, lld/sdks-and-tools.md §2). */
  ttlMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Reads `current_salt` from `intents.near` (view call, final), trying each RPC URL in turn. */
export function rpcSaltProvider(opts: RpcSaltProviderOptions = {}): SaltProvider {
  const urls = opts.rpcUrls ?? DEFAULT_NEAR_RPC_URLS;
  if (urls.length === 0) throw new RangeError("at least one RPC URL is required");
  const contract = opts.contract ?? INTENTS_CONTRACT;
  const ttl = opts.ttlMs ?? 60_000;
  const timeout = opts.timeoutMs ?? 3_000;
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let cached: { salt: string; at: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function read(): Promise<string> {
    const errors: string[] = [];
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "nearpay-agent-signer",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: "current_salt",
        args_base64: toBase64(new TextEncoder().encode("{}")),
      },
    });
    for (const url of urls) {
      try {
        const res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { result?: { result?: number[] }; error?: unknown };
        if (json.error !== undefined) throw new Error(`JSON-RPC error ${JSON.stringify(json.error).slice(0, 200)}`);
        const bytes = json.result?.result;
        if (!Array.isArray(bytes)) throw new Error("unexpected view result");
        return checkSalt(JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))));
      } catch (e) {
        errors.push(`${url}: ${(e as Error).message}`);
      }
    }
    throw new AgentSignerError("salt_unavailable", `could not read current_salt (${errors.join("; ")})`);
  }

  return async () => {
    if (cached && now() - cached.at < ttl) return cached.salt;
    inflight ??= read().finally(() => {
      inflight = null;
    });
    const salt = await inflight;
    cached = { salt, at: now() };
    return salt;
  };
}
