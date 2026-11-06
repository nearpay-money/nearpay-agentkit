/**
 * Agent side (lld/sdks-and-tools.md §2): `withX402(fetch, signer, {maxAmountPerRequest, allowedPayTo?})`
 * returns a fetch that, on `402`, picks the NearPay `intents-transfer` requirement, enforces the
 * client-side spend limits, signs via `@nearpay/agent-signer` and retries once with `PAYMENT-SIGNATURE`.
 * x402 requirements come from the merchant's own server and are signed as received: the limits are
 * the agent's protection.
 */
import {
  type BuildTransferOptions,
  buildTransferPayment,
  enforceSpendPolicy,
  type IntentSigner,
  type SpendLimit,
  transferTerms,
} from "@nearpay/agent-signer";
import {
  decodeX402Header,
  encodeX402Header,
  HEADERS,
  type PaymentPayload,
  PaymentRequirements,
  type PaymentRequirements as PaymentRequirementsT,
  ResourceInfo,
  SettleResponse,
  safeParseTolerant,
  X402_VERSION,
  type z,
} from "@nearpay/spec";

export interface WithX402Options extends Omit<BuildTransferOptions, "deadline"> {
  /** Maximum amount + fee per request, base units (one number for any asset, or per asset id). */
  maxAmountPerRequest: SpendLimit;
  /** Only pay these merchant Intents accounts. */
  allowedPayTo?: readonly string[];
  /** Called after the paid retry returns (whatever its status). */
  onPayment?: (e: X402PaymentEvent) => void;
}

/** What `onPayment` reports about one paid retry. */
export interface X402PaymentEvent {
  requirements: PaymentRequirementsT;
  payload: PaymentPayload;
  response: Response;
  /** The decoded `PAYMENT-RESPONSE`, or null when absent or unreadable. */
  settlement: z.output<typeof SettleResponse> | null;
  /**
   * The settlement repeats an earlier one for this payload (`SettleResponse.replayed`, spec 0.1.5):
   * no new debit happened, so budgets and payment counters must not count it again.
   */
  replayed: boolean;
}

export class X402ClientError extends Error {
  constructor(
    readonly code: "body_not_replayable",
    message: string,
  ) {
    super(message);
    this.name = "X402ClientError";
  }
}

interface Required402 {
  resource: z.output<typeof ResourceInfo>;
  accepts: PaymentRequirementsT[];
}

/** Reads `PAYMENT-REQUIRED`; keeps only the NearPay `exact` + `intents-transfer` entries. */
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
  const accepts = o.accepts.flatMap((a) => {
    const p = safeParseTolerant(PaymentRequirements, a);
    return p.success ? [p.data] : [];
  });
  return { resource: resource.data, accepts };
}

/**
 * Decodes `PAYMENT-RESPONSE` of a paid (or refused) request. Parsing is tolerant (spec 0.1.5): an
 * `errorReason` this version does not know is kept as received instead of discarding the response.
 */
export function decodePaymentResponse(res: Response): z.output<typeof SettleResponse> | null {
  const h = res.headers.get(HEADERS.x402PaymentResponse);
  if (!h) return null;
  try {
    const p = safeParseTolerant(SettleResponse, decodeX402Header(h));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export function withX402(fetchImpl: typeof fetch, signer: IntentSigner, opts: WithX402Options): typeof fetch {
  return async (input, init) => {
    const original = input instanceof Request ? input.clone() : null;
    const first = await fetchImpl(input, init);
    if (first.status !== 402) return first;
    const required = parsePaymentRequired(first.headers.get(HEADERS.x402PaymentRequired));
    const requirements = required?.accepts[0];
    if (!required || !requirements) return first;

    // Refusals (limits, recipients) throw AgentSignerError: the caller must know it chose not to pay.
    enforceSpendPolicy(transferTerms(requirements), {
      maxAmount: opts.maxAmountPerRequest,
      ...(opts.allowedPayTo ? { allowedPayTo: opts.allowedPayTo } : {}),
    });
    if (init?.body instanceof ReadableStream) {
      throw new X402ClientError("body_not_replayable", "a streamed request body cannot be sent again with the payment");
    }
    const signed = await buildTransferPayment(requirements, signer, opts);
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: required.resource,
      accepted: requirements,
      payload: { signed },
    };
    await first.body?.cancel();
    const headers = new Headers(original ? original.headers : init?.headers);
    headers.set(HEADERS.x402PaymentSignature, encodeX402Header(payload));
    const response = original
      ? await fetchImpl(new Request(original, { headers }))
      : await fetchImpl(input, { ...init, headers });
    if (opts.onPayment) {
      const settlement = decodePaymentResponse(response);
      opts.onPayment({ requirements, payload, response, settlement, replayed: settlement?.replayed === true });
    }
    return response;
  };
}
