/**
 * EVM origin wallets for the `nearpay-mcp` binary: builds viem wallet clients (one per configured
 * network) from a local private key and wraps them in `evmDepositor`. viem is an optional peer
 * dependency, loaded only when an EVM key is configured.
 */
import { type EvmWalletLike, evmDepositor, type OriginSigner } from "@nearpay-money/x402";
import { ConfigError } from "./config.js";

export async function viemOriginSigner(cfg: {
  privateKey: string;
  rpcUrls: Record<string, string>;
  nativeAssets?: Record<string, string>;
}): Promise<OriginSigner> {
  let viem: typeof import("viem");
  let accounts: typeof import("viem/accounts");
  let chains: typeof import("viem/chains");
  try {
    [viem, accounts, chains] = await Promise.all([import("viem"), import("viem/accounts"), import("viem/chains")]);
  } catch {
    throw new ConfigError("cross-chain EVM deposits need the optional dependency viem (npm i viem)");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey))
    throw new ConfigError("the EVM private key must be 0x + 64 hex digits");
  const account = accounts.privateKeyToAccount(cfg.privateKey as `0x${string}`);
  const byId = new Map(Object.values(chains).map((c) => [(c as { id: number }).id, c as import("viem").Chain]));
  const wallets: Record<string, EvmWalletLike> = {};
  for (const [network, rpc] of Object.entries(cfg.rpcUrls)) {
    const m = /^eip155:([1-9][0-9]*)$/.exec(network);
    if (!m) throw new ConfigError(`EVM RPC key ${network} is not an eip155 network`);
    const chain = byId.get(Number(m[1]));
    if (!chain) throw new ConfigError(`unknown EVM chain ${network}`);
    wallets[network] = viem.createWalletClient({
      account,
      chain,
      transport: viem.http(rpc),
    }) as unknown as EvmWalletLike;
  }
  if (Object.keys(wallets).length === 0) throw new ConfigError("NEARPAY_MCP_EVM_RPC_URLS lists no network");
  return evmDepositor(wallets, cfg.nativeAssets ? { nativeAssets: cfg.nativeAssets } : {});
}
