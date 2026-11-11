/**
 * NEAR Intents balance of the signing account (Verifier `mt_balance_of`, view call): lets an agent prefer
 * an `intents-transfer` requirement when it can cover it and fall back to a cross-chain `near-intents`
 * one otherwise (lld/sdks-and-tools.md §2). Read-only; a failed read is reported, never guessed.
 */
import { INTENTS_CONTRACT } from "@nearpay-money/spec";
import { toBase64 } from "./encoding.js";
import { AgentSignerError } from "./errors.js";
import { DEFAULT_NEAR_RPC_URLS } from "./salt.js";

/** Balance of `asset` (NEAR Intents id) held in the Verifier by the agent, base units. */
export type IntentsBalanceProvider = (accountId: string, asset: string) => Promise<bigint>;

export interface RpcBalanceProviderOptions {
  rpcUrls?: readonly string[];
  contract?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function rpcIntentsBalanceProvider(opts: RpcBalanceProviderOptions = {}): IntentsBalanceProvider {
  const urls = opts.rpcUrls ?? DEFAULT_NEAR_RPC_URLS;
  if (urls.length === 0) throw new RangeError("at least one RPC URL is required");
  const f = opts.fetch ?? fetch;
  return async (accountId, asset) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "nearpay-agent-signer",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: opts.contract ?? INTENTS_CONTRACT,
        method_name: "mt_balance_of",
        args_base64: toBase64(new TextEncoder().encode(JSON.stringify({ account_id: accountId, token_id: asset }))),
      },
    });
    const errors: string[] = [];
    for (const url of urls) {
      try {
        const res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { result?: { result?: number[] }; error?: unknown };
        if (json.error !== undefined) throw new Error(`JSON-RPC error ${JSON.stringify(json.error).slice(0, 200)}`);
        const bytes = json.result?.result;
        if (!Array.isArray(bytes)) throw new Error("unexpected view result");
        const v: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
        if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v)) throw new Error("balance is not base units");
        return BigInt(v);
      } catch (e) {
        errors.push(`${url}: ${(e as Error).message}`);
      }
    }
    throw new AgentSignerError("api_error", `could not read the Intents balance (${errors.join("; ")})`);
  };
}
