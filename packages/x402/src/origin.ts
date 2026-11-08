/**
 * Cross-chain deposits for `exact` + `near-intents` (lld/sdks-and-tools.md §2, agentpay §3.1): the agent
 * deposits the quoted `amount` of `asset` to the single-use 1Click deposit address (`payTo`) on the origin
 * network; 1Click delivers exactly the price to the merchant's NEAR Intents account.
 *
 * `OriginSigner` is what the agent's operator plugs in (the key never leaves their process); `evmDepositor`
 * adapts viem-style wallet clients for ERC-20 (and configured native-coin) deposits on EVM chains.
 * The persisted operation (`OperationStore`) holds the quote's `operationToken`, a bearer credential:
 * keep the store private, never log it.
 */
import type { NearIntentsPaymentRequirements, NearIntentsSettleResponse, z } from "@nearpay/spec";

export interface DepositRequest {
  /** Origin CAIP-2 network (`accepted.network`). */
  network: string;
  /** Origin asset as the x402 entry names it (EVM: token contract address). */
  asset: string;
  /** NEAR Intents id of the origin asset (`extra.originAssetId`), when given. */
  originAssetId?: string;
  /** Quoted amount to deposit, base units of the origin asset. */
  amount: string;
  /** The 1Click deposit address. */
  payTo: string;
  /** Memo / destination tag the deposit must carry, when the origin needs one. */
  memo?: string;
}

/** Pays deposits on origin chains for the agent. */
export interface OriginSigner {
  /** Whether this signer can deposit `asset` on `network`. */
  canPay(network: string, asset: string): boolean;
  /** The agent's address on `network`: receives refunds and the unused slippage buffer. */
  refundTo(network: string): string | Promise<string>;
  /**
   * Broadcasts the deposit and returns its transaction hash. Throw {@link DepositNotSentError} only when
   * nothing was broadcast; any other error is treated as "may have been sent".
   */
  deposit(d: DepositRequest): Promise<{ txHash: string }>;
}

/** The deposit was certainly not broadcast (validation failed before signing). */
export class DepositNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepositNotSentError";
  }
}

type Hex = `0x${string}`;

/** The parts of a viem `WalletClient` (with an account) the EVM depositor uses. */
export interface EvmWalletLike {
  account: { address: string };
  chain?: { id: number } | undefined;
  sendTransaction(tx: { account: never; to: Hex; data?: Hex; value?: bigint; chain?: never }): Promise<Hex>;
}

export interface EvmDepositorOptions {
  /** Native coins the depositor may send, by network: `{ "eip155:8453": "<asset as the entry names it>" }`. */
  nativeAssets?: Readonly<Record<string, string>>;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

/** ERC-20 `transfer(to, amount)` calldata. */
export function erc20TransferData(to: string, amount: bigint): Hex {
  if (!EVM_ADDRESS.test(to)) throw new DepositNotSentError(`deposit address ${to} is not an EVM address`);
  if (amount <= 0n || amount > MAX_UINT256) throw new DepositNotSentError("deposit amount out of range");
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

/** Deposits on EVM origin chains through viem-style wallet clients, one per CAIP-2 network. */
export function evmDepositor(
  wallets: Readonly<Record<string, EvmWalletLike>>,
  opts: EvmDepositorOptions = {},
): OriginSigner {
  const native = opts.nativeAssets ?? {};
  const wallet = (network: string): EvmWalletLike => {
    const w = Object.hasOwn(wallets, network) ? wallets[network] : undefined;
    if (!w) throw new DepositNotSentError(`no wallet configured for ${network}`);
    return w;
  };
  return {
    canPay: (network, asset) =>
      Object.hasOwn(wallets, network) &&
      /^eip155:[1-9][0-9]*$/.test(network) &&
      (EVM_ADDRESS.test(asset) || native[network] === asset),
    refundTo: (network) => wallet(network).account.address,
    async deposit(d) {
      const w = wallet(d.network);
      if (d.memo !== undefined) throw new DepositNotSentError("EVM deposits cannot carry a memo");
      const chainId = Number(d.network.slice("eip155:".length));
      if (w.chain && w.chain.id !== chainId) {
        throw new DepositNotSentError(`wallet for ${d.network} is on chain ${w.chain.id}`);
      }
      if (!/^[1-9][0-9]*$/.test(d.amount)) throw new DepositNotSentError("deposit amount must be positive base units");
      const amount = BigInt(d.amount);
      const account = w.account as never;
      let hash: Hex;
      if (native[d.network] === d.asset) {
        if (!EVM_ADDRESS.test(d.payTo))
          throw new DepositNotSentError(`deposit address ${d.payTo} is not an EVM address`);
        hash = await w.sendTransaction({ account, to: d.payTo as Hex, value: amount });
      } else if (EVM_ADDRESS.test(d.asset)) {
        hash = await w.sendTransaction({ account, to: d.asset as Hex, data: erc20TransferData(d.payTo, amount) });
      } else {
        throw new DepositNotSentError(`asset ${d.asset} is neither an ERC-20 contract nor a configured native coin`);
      }
      return { txHash: hash };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Persisted operations
// ---------------------------------------------------------------------------------------------

export type NearIntentsSettleResponseT = z.output<typeof NearIntentsSettleResponse>;

export type X402OperationState =
  /** The deposit is about to be broadcast (a crash here leaves it unknown). */
  | "depositing"
  /** The depositor failed in a way that may have broadcast: resolve by hand (resume with the tx hash). */
  | "deposit_unknown"
  /** Deposited; waiting for the merchant to be paid. */
  | "deposited"
  | "settled"
  | "failed";

/** One cross-chain payment, persisted before the deposit and updated after (lld/sdks-and-tools.md §2). */
export interface X402Operation {
  /** The unquoted entry's binding (one quote per binding). */
  id: string;
  state: X402OperationState;
  /** `resource.url` of the paid resource. */
  resourceUrl: string;
  /** The request that is retried with the deposit payload (no headers or body are stored). */
  request: { method: string; url: string };
  accepted: NearIntentsPaymentRequirements;
  /** The quoted entry, incl. `extra.operationToken` (a bearer credential). */
  quoted: NearIntentsPaymentRequirements;
  refundTo: string;
  txHash?: string;
  settlement?: NearIntentsSettleResponseT;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface OperationStore {
  get(id: string): Promise<X402Operation | undefined>;
  put(op: X402Operation): Promise<void>;
  list(): Promise<X402Operation[]>;
}

/** In-process store (operations are lost on exit; pass a durable store for long settlements). */
export function memoryOperationStore(): OperationStore {
  const m = new Map<string, X402Operation>();
  return {
    get: async (id) => {
      const op = m.get(id);
      return op ? structuredClone(op) : undefined;
    },
    put: async (op) => {
      m.set(op.id, structuredClone(op));
    },
    list: async () => [...m.values()].map((o) => structuredClone(o)),
  };
}

/** Operations whose deposit may be in flight: no second quote is funded for their resource. */
export const isOperationOpen = (op: X402Operation) =>
  op.state === "depositing" || op.state === "deposit_unknown" || op.state === "deposited";
