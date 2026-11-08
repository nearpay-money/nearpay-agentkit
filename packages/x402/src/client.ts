/**
 * Agent side (lld/sdks-and-tools.md §2): `withX402(fetch, signer, {maxAmountPerRequest, allowedPayTo?})`
 * returns a fetch that, on `402`, picks a NearPay requirement, enforces the client-side spend limits and
 * pays:
 *
 * - `exact` + `intents-transfer`: signs via `@nearpay/agent-signer` and retries once with
 *   `PAYMENT-SIGNATURE`.
 * - `exact` + `near-intents` (spec 0.3.0, `crossChain` option): retries with a `quote` payload, checks the
 *   quoted entry against the one it quoted, applies the spend limits to the **quoted** amount (origin
 *   units), persists `{payTo, depositMemo, operationToken}` before depositing and the `txHash` after, then
 *   retries with the `deposit` payload (same token) until a final result — backoff 5 s → 30 s, bounded by
 *   `refundDeadline` + 24 h or `maxWaitMs` — and never funds a second quote while one for the same
 *   resource is open.
 *
 * `intents-transfer` is preferred when the signer can cover it (Intents balance, when a balance provider
 * is given); otherwise a `near-intents` entry the origin signer can pay is chosen. Requirements come from
 * the merchant's own server and are paid as received: the limits and the pay-to allow-list (the merchant
 * Intents account: `payTo`, or `extra.destination.recipient` for near-intents) are the agent's protection.
 */
import {
  type BuildTransferOptions,
  buildTransferPayment,
  enforceSpendPolicy,
  type IntentSigner,
  type IntentsBalanceProvider,
  limitFor,
  type Reservation,
  type SpendingBudget,
  type SpendLimit,
  transferTerms,
} from "@nearpay/agent-signer";
import {
  BaseUnits,
  decodeX402Header,
  encodeX402Header,
  HEADERS,
  isNearIntentsRequirements,
  type NearIntentsPaymentPayload,
  NearIntentsPaymentRequirements,
  type NearIntentsPaymentRequirements as NearIntentsRequirementsT,
  NearIntentsSettleResponse,
  type PaymentPayload,
  PaymentRequirements,
  type PaymentRequirements as PaymentRequirementsT,
  ResourceInfo,
  SettleResponse,
  safeParseTolerant,
  X402_VERSION,
  type z,
} from "@nearpay/spec";
import {
  DepositNotSentError,
  isOperationOpen,
  memoryOperationStore,
  type NearIntentsSettleResponseT,
  type OperationStore,
  type OriginSigner,
  type X402Operation,
} from "./origin.js";

export type SettleResponseT = z.output<typeof SettleResponse>;

export interface CrossChainOptions {
  /** Pays deposits on origin chains. */
  originSigner: OriginSigner;
  /** Refund address on the origin network (default: `originSigner.refundTo(network)`). */
  refundTo?: string | Readonly<Record<string, string>> | ((network: string) => string);
  /** Origin assets (NEAR Intents ids) the agent may pay with, in preference order (default: any payable). */
  origins?: readonly string[];
  /** Slippage tolerance to ask for, bps (default: the facilitator's default). */
  slippageBps?: number;
  /** Where operations are persisted (default: in memory). */
  store?: OperationStore;
  /** Longest this call waits for settlement after depositing (default: until `refundDeadline` + 24 h). */
  maxWaitMs?: number;
  /** Refuse a quote whose `refundDeadline` is closer than this (default 120 s). */
  minDepositWindowMs?: number;
  /** Intents balance of the signer; when given, `intents-transfer` is used only if the balance covers it. */
  balance?: IntentsBalanceProvider;
}

export interface WithX402Options extends Omit<BuildTransferOptions, "deadline"> {
  /** Maximum debit per request, base units (one number for any asset, or per asset id). */
  maxAmountPerRequest: SpendLimit;
  /** Only pay these merchant Intents accounts. */
  allowedPayTo?: readonly string[];
  /** Session budget: each payment reserves its debit, committed once money (may have) moved. */
  budget?: SpendingBudget;
  /** Cross-chain `near-intents` payments (spec 0.3.0). */
  crossChain?: CrossChainOptions;
  /** Called after the paid retry returns (whatever its status). */
  onPayment?: (e: X402PaymentEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** What `onPayment` reports about one paid retry. */
export type X402PaymentEvent =
  | {
      method: "intents-transfer";
      requirements: PaymentRequirementsT;
      payload: PaymentPayload;
      response: Response;
      /** The decoded `PAYMENT-RESPONSE`, or null when absent or unreadable. */
      settlement: SettleResponseT | null;
      /**
       * The settlement repeats an earlier one for this payload (`SettleResponse.replayed`, spec 0.1.5):
       * no new debit happened, so budgets and payment counters must not count it again.
       */
      replayed: boolean;
    }
  | {
      method: "near-intents";
      /** The quoted entry that was paid. */
      requirements: NearIntentsRequirementsT;
      payload: NearIntentsPaymentPayload;
      response: Response;
      settlement: NearIntentsSettleResponseT | null;
      replayed: boolean;
      operation: X402Operation;
    };

export type X402ClientErrorCode =
  | "body_not_replayable"
  /** The server's quoted entry does not match the entry that was quoted, or leaves too little time. */
  | "quote_invalid"
  /** A cross-chain operation for this resource is still open (deposited or unknown): resume it. */
  | "operation_pending"
  /** Deposited, but no final result within the wait: resume later with the operation id. */
  | "settlement_pending"
  /** The deposit may or may not have been broadcast: resolve by hand. */
  | "deposit_unknown"
  | "operation_unknown";

export class X402ClientError extends Error {
  constructor(
    readonly code: X402ClientErrorCode,
    message: string,
    /** The cross-chain operation concerned, when there is one. */
    readonly operationId?: string,
  ) {
    super(message);
    this.name = "X402ClientError";
  }
}

interface Required402 {
  resource: z.output<typeof ResourceInfo>;
  accepts: PaymentRequirementsT[];
  /** `near-intents` entries (spec 0.3.0), in server order. */
  nearIntents: NearIntentsRequirementsT[];
}

/** Reads `PAYMENT-REQUIRED`; keeps the NearPay `exact` entries (`intents-transfer` and `near-intents`). */
export function parsePaymentRequired(header: string | null): Required402 | null {
  if (!header) return null;
  let v: unknown;
  try {
    v = decodeX402Header(header);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as { x402Version?: unknown; resource?: unknown; accepts?: unknown };
  const resource = safeParseTolerant(ResourceInfo, o.resource);
  if (o.x402Version !== X402_VERSION || !resource.success || !Array.isArray(o.accepts)) return null;
  const accepts: PaymentRequirementsT[] = [];
  const nearIntents: NearIntentsRequirementsT[] = [];
  for (const a of o.accepts) {
    if (isNearIntentsRequirements(a)) {
      const p = safeParseTolerant(NearIntentsPaymentRequirements, a);
      if (p.success) nearIntents.push(p.data);
    } else {
      const p = safeParseTolerant(PaymentRequirements, a);
      if (p.success) accepts.push(p.data);
    }
  }
  return { resource: resource.data, accepts, nearIntents };
}

/**
 * Decodes `PAYMENT-RESPONSE` of a paid (or refused) request. Parsing is tolerant (spec 0.1.5): an
 * `errorReason` this version does not know is kept as received instead of discarding the response.
 */
export function decodePaymentResponse(res: Response): SettleResponseT | null {
  const h = res.headers.get(HEADERS.x402PaymentResponse);
  if (!h) return null;
  try {
    const p = safeParseTolerant(SettleResponse, decodeX402Header(h));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

/** Decodes a `near-intents` `PAYMENT-RESPONSE` (`NearIntentsSettleResponse`, tolerant). */
export function decodeNearIntentsPaymentResponse(res: Response): NearIntentsSettleResponseT | null {
  const h = res.headers.get(HEADERS.x402PaymentResponse);
  if (!h) return null;
  try {
    const p = safeParseTolerant(NearIntentsSettleResponse, decodeX402Header(h));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

const JSON_EQ = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Checks the server's quoted entry against the unquoted entry the agent asked to quote (PR #3370:
 * `quotedRequirements`): same binding, network, asset, window and destination; a positive `amount`, a
 * deposit address, an operation token and enough time before `refundDeadline`.
 */
export function checkQuotedEntry(
  unquoted: NearIntentsRequirementsT,
  quoted: NearIntentsRequirementsT,
  now: number,
  minDepositWindowMs = 120_000,
): void {
  const fail = (why: string): never => {
    throw new X402ClientError("quote_invalid", `quoted entry refused: ${why}`, unquoted.extra.binding);
  };
  if (quoted.extra.binding !== unquoted.extra.binding) fail("another binding");
  if (
    quoted.scheme !== unquoted.scheme ||
    quoted.network !== unquoted.network ||
    quoted.asset !== unquoted.asset ||
    quoted.maxTimeoutSeconds !== unquoted.maxTimeoutSeconds
  ) {
    fail("network, asset or window changed");
  }
  if (!JSON_EQ(quoted.extra.destination, unquoted.extra.destination)) fail("destination changed");
  if (quoted.extra.originAssetId !== unquoted.extra.originAssetId) fail("origin asset changed");
  if (!BaseUnits.safeParse(quoted.amount).success || quoted.amount === "0" || quoted.amount === "") fail("no amount");
  if (quoted.payTo === "") fail("no deposit address");
  if (!quoted.extra.operationToken) fail("no operation token");
  const min = quoted.extra.minAmountIn;
  if (min !== undefined && BigInt(min) > BigInt(quoted.amount)) fail("minAmountIn above amount");
  const deadline = Date.parse(quoted.extra.refundDeadline ?? "");
  if (!Number.isFinite(deadline)) fail("no refund deadline");
  if (deadline - now < minDepositWindowMs) fail("refund deadline too close to deposit safely");
}

/** Debit of a quoted near-intents entry, in the terms the spend policy checks. */
function nearIntentsTerms(e: NearIntentsRequirementsT) {
  return {
    payTo: e.extra.destination.recipient,
    asset: e.extra.originAssetId ?? e.asset,
    amount: e.amount,
    feeTo: "",
    feeAmount: "0",
    binding: e.extra.binding ?? "",
    latestDeadline: e.extra.refundDeadline ?? "",
    kind: "x402" as const,
  };
}

interface Sender {
  /** Re-sends the original request with `PAYMENT-SIGNATURE` set to `header`. */
  send(header: string): Promise<Response>;
  method: string;
  url: string;
}

function makeSender(fetchImpl: typeof fetch, input: RequestInfo | URL, init: RequestInit | undefined): Sender {
  const original = input instanceof Request ? input.clone() : null;
  const url = original ? original.url : String(input instanceof URL ? input.href : input);
  return {
    method: (original?.method ?? init?.method ?? "GET").toUpperCase(),
    url,
    send: (header) => {
      const headers = new Headers(original ? original.headers : init?.headers);
      headers.set(HEADERS.x402PaymentSignature, header);
      return original ? fetchImpl(new Request(original.clone(), { headers })) : fetchImpl(input, { ...init, headers });
    },
  };
}

async function refundAddress(c: CrossChainOptions, network: string): Promise<string> {
  const r = c.refundTo;
  if (typeof r === "string") return r;
  if (typeof r === "function") return r(network);
  if (r && Object.hasOwn(r, network)) return r[network] as string;
  return c.originSigner.refundTo(network);
}

type Choice =
  | { method: "intents-transfer"; entry: PaymentRequirementsT }
  | { method: "near-intents"; entry: NearIntentsRequirementsT };

async function choose(
  required: Required402,
  signer: IntentSigner | null,
  opts: WithX402Options,
): Promise<Choice | null> {
  const allowed = (payTo: string) => !opts.allowedPayTo || opts.allowedPayTo.includes(payTo);
  const transfer = signer ? required.accepts[0] : undefined;
  const c = opts.crossChain;
  const crossChain = c
    ? required.nearIntents
        .filter((e) => {
          const origin = e.extra.originAssetId ?? e.asset;
          return (
            c.originSigner.canPay(e.network, e.asset) &&
            (!c.origins || c.origins.includes(origin)) &&
            limitFor(opts.maxAmountPerRequest, origin) !== null &&
            allowed(e.extra.destination.recipient)
          );
        })
        .sort((a, b) => {
          if (!c.origins) return 0;
          const rank = (e: NearIntentsRequirementsT) => c.origins?.indexOf(e.extra.originAssetId ?? e.asset) ?? 0;
          return rank(a) - rank(b);
        })
    : [];
  if (transfer && signer) {
    if (!crossChain[0] || !c?.balance) return { method: "intents-transfer", entry: transfer };
    const t = transferTerms(transfer);
    const balance = await c.balance(signer.signerId, t.asset).catch(() => null);
    if (balance === null || balance >= BigInt(t.amount) + BigInt(t.feeAmount)) {
      return { method: "intents-transfer", entry: transfer };
    }
  }
  if (crossChain[0]) return { method: "near-intents", entry: crossChain[0] };
  return transfer ? { method: "intents-transfer", entry: transfer } : null;
}

export function withX402(fetchImpl: typeof fetch, signer: IntentSigner | null, opts: WithX402Options): typeof fetch {
  return async (input, init) => {
    const sender = makeSender(fetchImpl, input, init);
    const first = await fetchImpl(input, init);
    if (first.status !== 402) return first;
    const required = parsePaymentRequired(first.headers.get(HEADERS.x402PaymentRequired));
    if (!required) return first;
    const choice = await choose(required, signer, opts);
    if (!choice) return first;
    if (init?.body instanceof ReadableStream) {
      throw new X402ClientError("body_not_replayable", "a streamed request body cannot be sent again with the payment");
    }
    await first.body?.cancel();
    if (choice.method === "near-intents") {
      return payNearIntents(sender, required, choice.entry, opts);
    }
    return payIntentsTransfer(sender, required, choice.entry, signer as IntentSigner, opts);
  };
}

async function payIntentsTransfer(
  sender: Sender,
  required: Required402,
  requirements: PaymentRequirementsT,
  signer: IntentSigner,
  opts: WithX402Options,
): Promise<Response> {
  // Refusals (limits, recipients) throw AgentSignerError: the caller must know it chose not to pay.
  const total = enforceSpendPolicy(transferTerms(requirements), {
    maxAmount: opts.maxAmountPerRequest,
    ...(opts.allowedPayTo ? { allowedPayTo: opts.allowedPayTo } : {}),
  });
  const reservation = opts.budget?.reserve(requirements.asset, total, { label: required.resource.url });
  let response: Response;
  let payload: PaymentPayload;
  try {
    const signed = await buildTransferPayment(requirements, signer, opts);
    payload = { x402Version: X402_VERSION, resource: required.resource, accepted: requirements, payload: { signed } };
  } catch (e) {
    reservation?.release(); // nothing left this process
    throw e;
  }
  try {
    response = await sender.send(encodeX402Header(payload));
  } catch (e) {
    reservation?.commit(); // the signed payload may have reached the server
    throw e;
  }
  const settlement = decodePaymentResponse(response);
  // A definite refusal moved nothing; anything else (success, pending, no answer) counts as spent.
  if (response.status === 402 && settlement && !settlement.success && settlement.errorReason !== "settlement_pending") {
    reservation?.release();
  } else {
    reservation?.commit();
  }
  opts.onPayment?.({
    method: "intents-transfer",
    requirements,
    payload,
    response,
    settlement,
    replayed: settlement?.replayed === true,
  });
  return response;
}

async function payNearIntents(
  sender: Sender,
  required: Required402,
  entry: NearIntentsRequirementsT,
  opts: WithX402Options,
): Promise<Response> {
  const c = opts.crossChain as CrossChainOptions;
  const store = storeOf(c);
  const now = opts.now ?? Date.now;
  const binding = entry.extra.binding;
  if (!binding) throw new X402ClientError("quote_invalid", "near-intents entry without a binding");
  if (opts.allowedPayTo && !opts.allowedPayTo.includes(entry.extra.destination.recipient)) {
    // `choose` filters these; kept as a guard for direct callers.
    throw new X402ClientError("quote_invalid", "merchant not allowed", binding);
  }

  // Never fund a second quote while an operation for this resource may still deliver.
  const open = (await store.list()).find((o) => isOperationOpen(o) && o.resourceUrl === required.resource.url);
  if (open) {
    if (open.state === "deposited") return redeem(sender, open, opts);
    throw new X402ClientError(
      "operation_pending",
      `a cross-chain payment for ${required.resource.url} is ${open.state}; resolve it before paying again`,
      open.id,
    );
  }

  const refundTo = await refundAddress(c, entry.network);
  const quotePayload: NearIntentsPaymentPayload = {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted: entry,
    payload: { type: "quote", refundTo, ...(c.slippageBps !== undefined ? { slippageTolerance: c.slippageBps } : {}) },
  };
  const second = await sender.send(encodeX402Header(quotePayload));
  if (second.status !== 402) return second; // not a NearPay quote answer: hand it back untouched
  const quotedRequired = parsePaymentRequired(second.headers.get(HEADERS.x402PaymentRequired));
  const quoted = quotedRequired?.nearIntents.find((e) => e.extra.binding === binding);
  if (!quoted) return second; // quote refused (PAYMENT-RESPONSE says why) or no quote offered
  await second.body?.cancel();
  checkQuotedEntry(entry, quoted, now(), c.minDepositWindowMs);

  // Limits apply to what leaves the agent's wallet: the quoted amount in origin units.
  const terms = nearIntentsTerms(quoted);
  const total = enforceSpendPolicy(terms, {
    maxAmount: opts.maxAmountPerRequest,
    ...(opts.allowedPayTo ? { allowedPayTo: opts.allowedPayTo } : {}),
  });
  const reservation: Reservation | undefined = opts.budget?.reserve(terms.asset, total, {
    label: required.resource.url,
  });

  const t = now();
  const op: X402Operation = {
    id: binding,
    state: "depositing",
    resourceUrl: required.resource.url,
    request: { method: sender.method, url: sender.url },
    accepted: entry,
    quoted,
    refundTo,
    createdAt: t,
    updatedAt: t,
  };
  try {
    await store.put(op); // persisted before the deposit: a crash after it can still be resolved
  } catch (e) {
    reservation?.release();
    throw e;
  }
  try {
    const { txHash } = await c.originSigner.deposit({
      network: quoted.network,
      asset: quoted.asset,
      ...(quoted.extra.originAssetId ? { originAssetId: quoted.extra.originAssetId } : {}),
      amount: quoted.amount,
      payTo: quoted.payTo,
      ...(quoted.extra.depositMemo ? { memo: quoted.extra.depositMemo } : {}),
    });
    reservation?.commit();
    Object.assign(op, { state: "deposited", txHash, updatedAt: now() });
    await store.put(op);
  } catch (e) {
    if (e instanceof DepositNotSentError) {
      reservation?.release();
      Object.assign(op, { state: "failed", error: `deposit not sent: ${e.message}`, updatedAt: now() });
      await store.put(op);
      throw e;
    }
    reservation?.commit(); // may have been broadcast
    Object.assign(op, { state: "deposit_unknown", error: (e as Error).message, updatedAt: now() });
    await store.put(op);
    throw new X402ClientError(
      "deposit_unknown",
      `the deposit may have been sent (${(e as Error).message}); resume with its transaction hash`,
      op.id,
    );
  }
  return redeem(sender, op, opts);
}

const storeOf = (() => {
  const defaults = new WeakMap<CrossChainOptions, OperationStore>();
  return (c: CrossChainOptions): OperationStore => {
    if (c.store) return c.store;
    let s = defaults.get(c);
    if (!s) {
      s = memoryOperationStore();
      defaults.set(c, s);
    }
    return s;
  };
})();

const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 30_000;
const REDEEM_GRACE_MS = 86_400_000;

/** Presents the deposit until a final result (or the wait runs out). */
async function redeem(sender: Sender, op: X402Operation, opts: WithX402Options): Promise<Response> {
  const c = opts.crossChain as CrossChainOptions;
  const store = storeOf(c);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!op.txHash) throw new X402ClientError("deposit_unknown", "operation has no deposit transaction", op.id);
  const token = op.quoted.extra.operationToken as string;
  const payload: NearIntentsPaymentPayload = {
    x402Version: X402_VERSION,
    resource: { url: op.resourceUrl },
    accepted: op.accepted,
    payload: {
      type: "deposit",
      operationToken: token,
      depositAddress: op.quoted.payTo,
      ...(op.quoted.extra.depositMemo ? { depositMemo: op.quoted.extra.depositMemo } : {}),
      txHash: op.txHash,
    },
  };
  const header = encodeX402Header(payload);
  const hardLimit = Date.parse(op.quoted.extra.refundDeadline ?? "") + REDEEM_GRACE_MS;
  const until = Math.min(hardLimit, c.maxWaitMs !== undefined ? now() + c.maxWaitMs : hardLimit);
  let delay = BACKOFF_START_MS;
  for (;;) {
    let response: Response | null = null;
    try {
      response = await sender.send(header);
    } catch {
      response = null; // transient: retried below
    }
    const settlement = response ? decodeNearIntentsPaymentResponse(response) : null;
    const pending =
      !response ||
      response.status >= 500 ||
      (response.status === 402 && (!settlement || settlement.errorReason === "settlement_pending"));
    if (response && !pending) {
      const ok = response.status < 400;
      Object.assign(op, {
        state: ok ? "settled" : "failed",
        ...(settlement ? { settlement } : {}),
        ...(ok ? {} : { error: settlement?.errorReason ?? `HTTP ${response.status}` }),
        updatedAt: now(),
      });
      await store.put(op);
      opts.onPayment?.({
        method: "near-intents",
        requirements: op.quoted,
        payload,
        response,
        settlement,
        replayed: settlement?.replayed === true,
        operation: op,
      });
      return response;
    }
    await response?.body?.cancel();
    if (now() + delay > until) {
      throw new X402ClientError(
        "settlement_pending",
        `deposit ${op.txHash} is not settled yet (${settlement?.extra?.status ?? settlement?.errorReason ?? "no answer"}); resume later`,
        op.id,
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 2, BACKOFF_MAX_MS);
  }
}

export interface ResumeOptions extends WithX402Options {
  crossChain: CrossChainOptions;
  /** Headers and body for the retried request (none are stored with the operation). */
  init?: Omit<RequestInit, "method">;
  /** For a `deposit_unknown` operation: the deposit transaction that was found on chain. */
  txHash?: string;
}

/**
 * Continues a stored cross-chain operation: presents its deposit again (after `settlement_pending`) or,
 * for `deposit_unknown`, records the given deposit transaction first. Never deposits.
 */
export async function resumeX402Operation(
  fetchImpl: typeof fetch,
  operationId: string,
  opts: ResumeOptions,
): Promise<Response> {
  const store = storeOf(opts.crossChain);
  const op = await store.get(operationId);
  if (!op) throw new X402ClientError("operation_unknown", `no stored operation ${operationId}`, operationId);
  if (op.state === "depositing" || op.state === "deposit_unknown") {
    if (!opts.txHash) {
      throw new X402ClientError("deposit_unknown", "the deposit of this operation is unknown: pass its txHash", op.id);
    }
    Object.assign(op, { state: "deposited", txHash: opts.txHash, updatedAt: (opts.now ?? Date.now)() });
    await store.put(op);
  } else if (op.state !== "deposited") {
    throw new X402ClientError("operation_unknown", `operation ${op.id} is already ${op.state}`, op.id);
  }
  const sender = makeSender(fetchImpl, op.request.url, { ...opts.init, method: op.request.method });
  return redeem(sender, op, opts);
}
