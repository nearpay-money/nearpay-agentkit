/**
 * Evidence links returned with every payment (lld/sdks-and-tools.md §2): transaction hashes with block
 * explorer links where the chain is public, and the NearPay object ids the merchant sees. Test mode runs
 * against the NearPay sandbox: its transactions are not on a public chain, so no explorer link is given.
 */

const evm = (base: string) => `${base}/tx/{tx}`;

/** Explorer templates by CAIP-2 network (same table as the platform's chain registry). */
export const EXPLORER_TX_URLS: Readonly<Record<string, string>> = Object.freeze({
  "near:mainnet": "https://nearblocks.io/txns/{tx}",
  "eip155:1": evm("https://etherscan.io"),
  "eip155:8453": evm("https://basescan.org"),
  "eip155:42161": evm("https://arbiscan.io"),
  "eip155:10": evm("https://optimistic.etherscan.io"),
  "eip155:137": evm("https://polygonscan.com"),
  "eip155:56": evm("https://bscscan.com"),
  "eip155:43114": evm("https://snowtrace.io"),
  "eip155:100": evm("https://gnosisscan.io"),
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "https://solscan.io/tx/{tx}",
  "bip122:000000000019d6689c085ae165831e93": "https://mempool.space/tx/{tx}",
  "bip122:12a765e31ffd4059bada1e25190f6e98": "https://litecoinspace.org/tx/{tx}",
  "bip122:1a91e3dace36e2be3bf030a65679fe82": "https://dogechain.info/tx/{tx}",
});

export type EvidenceKind =
  | "settlement_tx"
  | "deposit_tx"
  | "agent_payment"
  | "payment_intent"
  | "checkout_session"
  | "invoice"
  | "attestation";

export interface EvidenceLink {
  kind: EvidenceKind;
  /** Transaction hash or NearPay object id. */
  id: string;
  network?: string;
  /** Public explorer link, or null (test mode, unknown chain, or a NearPay object). */
  url: string | null;
  note?: string;
}

const SANDBOX_NOTE = "test mode: NearPay sandbox transaction, not on a public chain";

export function explorerTxUrl(network: string, tx: string, livemode: boolean): string | null {
  if (!livemode || !tx) return null;
  const t = Object.hasOwn(EXPLORER_TX_URLS, network) ? EXPLORER_TX_URLS[network] : undefined;
  return t ? t.replace("{tx}", encodeURIComponent(tx)) : null;
}

export function txEvidence(
  kind: "settlement_tx" | "deposit_tx",
  network: string,
  tx: string,
  livemode: boolean,
): EvidenceLink {
  const url = explorerTxUrl(network, tx, livemode);
  return { kind, id: tx, network, url, ...(livemode ? {} : { note: SANDBOX_NOTE }) };
}

export function objectEvidence(kind: EvidenceKind, id: string, note?: string): EvidenceLink {
  return { kind, id, url: null, ...(note ? { note } : {}) };
}
