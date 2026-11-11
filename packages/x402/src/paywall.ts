/**
 * The x402 paywall, framework-independent (lld/sdks-and-tools.md §2):
 *
 *   no `PAYMENT-SIGNATURE` → `POST /x402/requirements` (one call per 402 response, never cached: each
 *       binding is single-use) → `402` with `PAYMENT-REQUIRED: base64(PaymentRequired)` and body `{}`
 *   header → decode → local checks → `POST /x402/verify` → invalid → `402` + `PAYMENT-RESPONSE` failure
 *       valid → `POST /x402/settle` → success → handler runs, `PAYMENT-RESPONSE: base64(SettleResponse)`
 *       `settlement_pending` → one retry after 1 s, then `402` with the pending response
 *
 * Cross-chain (`near-intents`, spec 0.3.0, agentpay §3.1) when the config lists `origins`: requirements
 * come from `POST /x402/near-intents/requirements` (both methods in one `PAYMENT-REQUIRED`), and a payload
 * is dispatched by `accepted.extra.assetTransferMethod`:
 *   `intents-transfer` → `/x402/verify|settle` as above;
 *   `near-intents` `quote` → `/x402/near-intents/verify`, then a second `402` holding
 *       `quotedRequirements(entry, extra)` (a quote never serves the resource);
 *   `near-intents` `deposit` → `/x402/near-intents/settle` before the handler; `settlement_pending` →
 *       `402` with the pending `PAYMENT-RESPONSE` (no retry: cross-chain delivery takes minutes).
 * `paymentRequirements` is the paywall's **own** unquoted entry (remembered in process by binding); on
 * another replica, after a restart or past the memory bound it is the client's `accepted` after the
 * local checks below, which the facilitator compares with the issued entry anyway (agentpay §4.2).
 *
 * Local checks (defence in depth, the facilitator re-checks everything): the payload must pay this
 * paywall's amount (and asset / payTo / window / origin when configured), and name this resource. The
 * payload is forwarded with `resource` set to this paywall's resource URL.
 *
 * Replay guard: the facilitator's settle is idempotent (payload hash; per operation for near-intents), so
 * a replayed `PAYMENT-SIGNATURE` would get `success` again. The paywall remembers bindings it settled or
 * is settling (in process, 10 min, bounded) and refuses them (`requirement_consumed`;
 * `exact_near_intents_operation_executed` for near-intents). Across replicas (or after the 10 min) the
 * facilitator flags the repeat with `replayed` (spec 0.1.5 / 0.3.0): a replayed success is refused the
 * same way, so the resource is delivered once per settlement. No exception after `settlement_pending`:
 * agentpay never marks the first final answer as replayed (pending answers do not claim the result).
 */
import {
  BaseUnits,
  decodeX402Header,
  encodeX402Header,
  HEADERS,
  isNearIntentsRequirements,
  NearIntentsPaymentPayload,
  type NearIntentsPaymentPayload as NearIntentsPaymentPayloadT,
  type NearIntentsPaymentRequirements,
  type NearIntentsSettleResponse,
  PaymentPayload,
  type PaymentPayload as PaymentPayloadT,
  QUOTED_ONLY_EXTRA,
  quotedRequirements,
  type SettleResponse,
  X402_NETWORK,
  X402_VERSION,
  type z,
} from "@nearpay-money/spec";
import { type Facilitator, FacilitatorError, type FacilitatorOptions, facilitator } from "./facilitator.js";

export type SettleResponseT = z.output<typeof SettleResponse>;
export type NearIntentsSettleResponseT = z.output<typeof NearIntentsSettleResponse>;

/** An origin chain/asset a payer may deposit from (cross-chain `near-intents`). */
export interface PaywallOrigin {
  /** Origin asset, NEAR Intents id (from `GET /v1/assets`), e.g. Base USDC `nep141:base-0x8335….omft.near`. */
  asset_id: string;
  /** Deposit window, 60–86 400 s; default from the origin chain's profile. */
  max_timeout_s?: number;
}

export interface PaywallConfig {
  /** Amount the merchant receives, in base units of the asset (e.g. `"10000"` = 0.01 USDC). */
  amount: bigint | string | number;
  /** NEAR Intents asset id; default: the asset of the account's default Intents destination. */
  asset?: string;
  /** Merchant Intents account; default: the account's default Intents destination. */
  payTo?: string;
  description?: string;
  mimeType?: string;
  /** `intents-transfer` settlement window, 30–300 s (default 120). */
  maxTimeoutSeconds?: number;
  /**
   * Cross-chain origins (1–20, spec 0.3.0): payers without a NEAR Intents balance deposit on one of these
   * chains and 1Click delivers exactly `amount` to the merchant. Unset: `intents-transfer` only.
   */
  origins?: readonly PaywallOrigin[];
  /** With `origins`: also offer `intents-transfer` (default true). */
  includeIntentsTransfer?: boolean;
  /** With `origins`: how long the unquoted entries can be quoted, 30–900 s (default 300). */
  quoteWindowSeconds?: number;
}

/** What the paywall needs from an incoming request. */
export interface PaywallRequest {
  /** Absolute URL of the resource as the client sees it. */
  url: string;
  header(name: string): string | null | undefined;
}

interface PaidBase {
  payer: string;
  resource: string;
}

/** A request paid from a NEAR Intents balance (`exact` + `intents-transfer`). */
export interface IntentsTransferPaidRequest extends PaidBase {
  method: "intents-transfer";
  settlement: SettleResponseT;
  payment: PaymentPayloadT;
}

/** A request paid cross-chain (`exact` + `near-intents`): the merchant received exactly the price. */
export interface NearIntentsPaidRequest extends PaidBase {
  method: "near-intents";
  settlement: NearIntentsSettleResponseT;
  payment: NearIntentsPaymentPayloadT;
}

/** A paid request; narrow on `method` before reading method-specific fields. */
export type PaidRequest = IntentsTransferPaidRequest | NearIntentsPaidRequest;

export interface PaywallOptions extends FacilitatorOptions {
  /** The resource URL bound into requirements; default: the request URL. */
  resourceUrl?: string | ((req: PaywallRequest) => string);
  /** Delay before the one `settlement_pending` retry of `intents-transfer` (default 1000 ms). */
  pendingRetryMs?: number;
  /** Called after a successful settlement, before the handler runs. */
  onSettled?: (paid: PaidRequest) => void;
  /** Called with facilitator failures (the client gets 500/503). */
  onError?: (err: unknown) => void;
  /** For tests: replaces the facilitator client. */
  facilitator?: Facilitator;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const REPLAY_TTL_MS = 600_000;
const REPLAY_MAX = 10_000;
/** Issued unquoted entries are kept until their quote deadline (+ slack for the round trip). */
const ISSUED_SLACK_MS = 60_000;

export type PaywallResult =
  | { paid: false; status: number; headers: Record<string, string>; body: unknown }
  | ({ paid: true; headers: Record<string, string> } & PaidRequest);

export type Paywall = (req: PaywallRequest) => Promise<PaywallResult>;

/** The paid request without the transport fields (what adapters hand to the handler). */
export function paidRequestOf(out: PaywallResult & { paid: true }): PaidRequest {
  const { paid: _paid, headers: _headers, ...rest } = out;
  return rest as PaidRequest;
}

function baseUnits(v: bigint | string | number): string {
  const s = typeof v === "number" ? (Number.isSafeInteger(v) ? String(v) : "x") : String(v);
  if (!BaseUnits.safeParse(s).success || s === "0") {
    throw new RangeError("paywall amount must be a positive integer in base units");
  }
  return s;
}

const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

function checkOrigins(config: PaywallConfig): readonly PaywallOrigin[] | null {
  const o = config.origins;
  if (o === undefined) return null;
  if (o.length < 1 || o.length > 20) throw new RangeError("origins must list 1–20 origin assets");
  const seen = new Set<string>();
  for (const x of o) {
    if (typeof x.asset_id !== "string" || x.asset_id.length === 0) throw new RangeError("origin asset_id is required");
    if (seen.has(x.asset_id)) throw new RangeError(`origin ${x.asset_id} is listed twice`);
    seen.add(x.asset_id);
    if (x.max_timeout_s !== undefined && !isInt(x.max_timeout_s, 60, 86_400)) {
      throw new RangeError("origin max_timeout_s must be an integer between 60 and 86400");
    }
  }
  if (config.quoteWindowSeconds !== undefined && !isInt(config.quoteWindowSeconds, 30, 900)) {
    throw new RangeError("quoteWindowSeconds must be an integer between 30 and 900");
  }
  return o;
}

const settleFailure = (errorReason: string, errorMessage?: string, payer?: string): SettleResponseT => ({
  success: false,
  transaction: "",
  network: X402_NETWORK,
  ...(payer ? { payer } : {}),
  errorReason: errorReason as SettleResponseT["errorReason"],
  ...(errorMessage ? { errorMessage } : {}),
});

const nearIntentsFailure = (
  network: string,
  errorReason: string,
  errorMessage?: string,
  payer?: string,
): NearIntentsSettleResponseT => ({
  success: false,
  transaction: "",
  network,
  ...(payer ? { payer } : {}),
  errorReason: errorReason as NearIntentsSettleResponseT["errorReason"],
  ...(errorMessage ? { errorMessage } : {}),
});

export function createPaywall(config: PaywallConfig, opts: PaywallOptions): Paywall {
  const amount = baseUnits(config.amount);
  const window = config.maxTimeoutSeconds;
  if (window !== undefined && !isInt(window, 30, 300)) {
    throw new RangeError("maxTimeoutSeconds must be an integer between 30 and 300");
  }
  const origins = checkOrigins(config);
  const custom = opts.facilitator;
  if (origins && custom && !(custom.nearIntentsRequirements && custom.nearIntentsVerify && custom.nearIntentsSettle)) {
    throw new RangeError("origins need a facilitator with the near-intents routes");
  }
  const fac = (custom ?? facilitator(opts)) as Required<Facilitator>;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  const settledBindings = new Map<string, number>(); // binding → forget after (ms)
  const inflight = new Set<string>();
  const issued = new Map<string, { entry: NearIntentsPaymentRequirements; until: number }>();

  const bounded = <V>(m: Map<string, V>, expired: (v: V, t: number) => boolean) => {
    if (m.size < REPLAY_MAX) return;
    const t = now();
    for (const [k, v] of m) if (expired(v, t)) m.delete(k);
    while (m.size >= REPLAY_MAX) m.delete(m.keys().next().value as string);
  };
  const remember = (binding: string) => {
    bounded(settledBindings, (until, t) => until <= t);
    settledBindings.set(binding, now() + REPLAY_TTL_MS);
  };
  const settled = (binding: string) => (settledBindings.get(binding) ?? 0) > now();
  const seen = (binding: string) => inflight.has(binding) || settled(binding);
  const rememberIssued = (entry: NearIntentsPaymentRequirements) => {
    const binding = entry.extra.binding;
    if (!binding) return;
    const deadline = entry.extra.deadline ? Date.parse(entry.extra.deadline) : Number.NaN;
    const until = (Number.isFinite(deadline) ? deadline : now() + 900_000) + ISSUED_SLACK_MS;
    bounded(issued, (v, t) => v.until <= t);
    issued.set(binding, { entry, until });
  };
  const ownEntry = (binding: string) => {
    const e = issued.get(binding);
    return e && e.until > now() ? e.entry : undefined;
  };

  const reject = (s: SettleResponseT | NearIntentsSettleResponseT): PaywallResult => ({
    paid: false,
    status: 402,
    headers: { [HEADERS.x402PaymentResponse]: encodeX402Header(s) },
    body: {},
  });

  const unavailable = (err: unknown): PaywallResult => {
    opts.onError?.(err);
    const config4xx = err instanceof FacilitatorError && err.status >= 400 && err.status < 500;
    return config4xx
      ? { paid: false, status: 500, headers: {}, body: { error: "payment_misconfigured" } }
      : { paid: false, status: 503, headers: { [HEADERS.retryAfter]: "1" }, body: { error: "payment_unavailable" } };
  };

  const succeed = (paid: PaidRequest, s: SettleResponseT | NearIntentsSettleResponseT): PaywallResult => {
    opts.onSettled?.(paid);
    return { paid: true, headers: { [HEADERS.x402PaymentResponse]: encodeX402Header(s) }, ...paid };
  };

  type Resource = { url: string; description?: string; mimeType?: string };

  async function issue(resource: Resource): Promise<PaywallResult> {
    try {
      let required: unknown;
      if (origins) {
        const body = await fac.nearIntentsRequirements({
          resource,
          amount,
          ...(config.asset ? { asset_id: config.asset } : {}),
          ...(config.payTo ? { pay_to: config.payTo } : {}),
          origins: origins.map((o) => ({
            asset_id: o.asset_id,
            ...(o.max_timeout_s !== undefined ? { max_timeout_s: o.max_timeout_s } : {}),
          })),
          include_intents_transfer: config.includeIntentsTransfer ?? true,
          max_timeout_s: window ?? 120,
          quote_window_s: config.quoteWindowSeconds ?? 300,
        });
        for (const e of body.accepts) if (isNearIntentsRequirements(e)) rememberIssued(e);
        required = body;
      } else {
        required = await fac.requirements({
          resource,
          amount,
          ...(config.asset ? { asset_id: config.asset } : {}),
          ...(config.payTo ? { pay_to: config.payTo } : {}),
          ...(window ? { max_timeout_s: window } : {}),
        });
      }
      return {
        paid: false,
        status: 402,
        headers: { [HEADERS.x402PaymentRequired]: encodeX402Header(required) },
        body: {},
      };
    } catch (e) {
      return unavailable(e);
    }
  }

  async function intentsTransfer(raw: unknown, resource: Resource): Promise<PaywallResult> {
    const parsed = PaymentPayload.safeParse(raw);
    if (!parsed.success) {
      return reject(settleFailure("invalid_payload", "PAYMENT-SIGNATURE is not a NearPay x402 payment payload"));
    }
    const payment = parsed.data;
    const a = payment.accepted;
    const mismatch =
      a.amount !== amount
        ? "amount"
        : config.asset && a.asset !== config.asset
          ? "asset"
          : config.payTo && a.payTo !== config.payTo
            ? "payTo"
            : window && a.maxTimeoutSeconds !== window
              ? "maxTimeoutSeconds"
              : payment.resource && payment.resource.url !== resource.url
                ? "resource"
                : origins && config.includeIntentsTransfer === false
                  ? "method"
                  : null;
    if (mismatch) {
      return reject(settleFailure("invalid_payment_requirements", `the payment's ${mismatch} is not this resource's`));
    }
    const binding = a.extra.binding;
    if (seen(binding)) return reject(settleFailure("requirement_consumed", "this payment was already used"));
    const body = {
      x402Version: X402_VERSION,
      paymentPayload: { ...payment, resource: { ...payment.resource, ...resource } },
      paymentRequirements: a,
    };

    inflight.add(binding);
    try {
      const verdict = await fac.verify(body);
      if (!verdict.isValid) {
        return reject(settleFailure(verdict.invalidReason ?? "invalid_payload", verdict.invalidMessage, verdict.payer));
      }
      let s = await fac.settle(body);
      if (!s.success && s.errorReason === "settlement_pending") {
        await sleep(opts.pendingRetryMs ?? 1000);
        s = await fac.settle(body);
      }
      if (!s.success) return reject(s);
      remember(binding);
      if (s.replayed === true) {
        // Settled for an earlier request (another replica, or after the in-process memory expired).
        return reject(settleFailure("requirement_consumed", "this payment was already settled", s.payer));
      }
      return succeed(
        {
          method: "intents-transfer",
          payer: s.payer ?? verdict.payer ?? "",
          settlement: s,
          payment,
          resource: resource.url,
        },
        s,
      );
    } catch (e) {
      return unavailable(e);
    } finally {
      inflight.delete(binding);
    }
  }

  async function nearIntents(raw: unknown, resource: Resource): Promise<PaywallResult> {
    const network = (raw as { accepted?: { network?: unknown } }).accepted?.network;
    const net = typeof network === "string" ? network : X402_NETWORK;
    if (!origins) {
      return reject(
        nearIntentsFailure(net, "invalid_payment_requirements", "this resource does not accept near-intents payments"),
      );
    }
    const parsed = NearIntentsPaymentPayload.safeParse(raw);
    if (!parsed.success) {
      return reject(nearIntentsFailure(net, "invalid_payload", "PAYMENT-SIGNATURE is not a near-intents payload"));
    }
    const payment = parsed.data;
    const a = payment.accepted;
    const origin = origins.find((o) => o.asset_id === a.extra.originAssetId);
    const quotedField = QUOTED_ONLY_EXTRA.find((k) => a.extra[k] !== undefined);
    const binding = a.extra.binding;
    const mismatch =
      quotedField || a.amount !== "" || a.payTo !== ""
        ? "accepted entry (it must be the unquoted one)"
        : !binding
          ? "binding"
          : a.extra.destination.amount !== amount
            ? "amount"
            : config.asset && a.extra.destination.asset !== config.asset
              ? "asset"
              : config.payTo && a.extra.destination.recipient !== config.payTo
                ? "payTo"
                : !origin
                  ? "origin"
                  : origin.max_timeout_s !== undefined && a.maxTimeoutSeconds !== origin.max_timeout_s
                    ? "maxTimeoutSeconds"
                    : payment.resource.url !== resource.url
                      ? "resource"
                      : null;
    if (mismatch || !binding) {
      return reject(
        nearIntentsFailure(
          a.network,
          "invalid_payment_requirements",
          `the payment's ${mismatch} is not this resource's`,
        ),
      );
    }
    const own = ownEntry(binding);
    if (own && (own.network !== a.network || own.asset !== a.asset)) {
      // The facilitator compares every term with the issued entry (JCS); this catches a swapped origin early.
      return reject(
        nearIntentsFailure(a.network, "invalid_payment_requirements", "the payment's entry is not the one issued"),
      );
    }
    const paymentRequirements = own ?? a;
    const body = {
      x402Version: X402_VERSION,
      paymentPayload: { ...payment, resource: { ...payment.resource, ...resource } },
      paymentRequirements,
    };

    if (payment.payload.type === "quote") {
      if (settled(binding)) {
        return reject(nearIntentsFailure(a.network, "exact_near_intents_operation_executed", "already paid"));
      }
      try {
        const v = await fac.nearIntentsVerify(body);
        if (!v.isValid) {
          return reject(nearIntentsFailure(a.network, v.invalidReason ?? "invalid_payload", v.invalidMessage, v.payer));
        }
        if (!v.extra) throw new FacilitatorError("x402NearIntentsVerify: valid quote without a quote", 502);
        const quoted = quotedRequirements(paymentRequirements, v.extra);
        return {
          paid: false,
          status: 402,
          headers: {
            [HEADERS.x402PaymentRequired]: encodeX402Header({
              x402Version: X402_VERSION,
              error: "deposit required: pay the quoted entry",
              resource,
              accepts: [quoted],
            }),
          },
          body: {},
        };
      } catch (e) {
        return unavailable(e);
      }
    }

    const deposit = payment.payload;
    if (settled(binding)) {
      return reject(nearIntentsFailure(a.network, "exact_near_intents_operation_executed", "already paid"));
    }
    if (inflight.has(binding)) {
      // Another request of this operation is settling right now: answer pending, the client retries.
      return reject({ ...nearIntentsFailure(a.network, "settlement_pending"), transaction: deposit.txHash });
    }
    inflight.add(binding);
    try {
      const s = await fac.nearIntentsSettle(body);
      if (!s.success) return reject(s);
      remember(binding);
      if (s.replayed === true) {
        return reject(nearIntentsFailure(a.network, "exact_near_intents_operation_executed", "already paid", s.payer));
      }
      return succeed(
        { method: "near-intents", payer: s.payer ?? "", settlement: s, payment, resource: resource.url },
        s,
      );
    } catch (e) {
      return unavailable(e);
    } finally {
      inflight.delete(binding);
    }
  }

  return async (req) => {
    const resourceUrl = typeof opts.resourceUrl === "function" ? opts.resourceUrl(req) : (opts.resourceUrl ?? req.url);
    const resource: Resource = {
      url: resourceUrl,
      ...(config.description ? { description: config.description } : {}),
      ...(config.mimeType ? { mimeType: config.mimeType } : {}),
    };
    const header = req.header(HEADERS.x402PaymentSignature);
    if (!header) return issue(resource);

    let raw: unknown;
    try {
      raw = decodeX402Header(header);
    } catch {
      return reject(settleFailure("invalid_payload", "PAYMENT-SIGNATURE is not a NearPay x402 payment payload"));
    }
    const accepted = raw && typeof raw === "object" ? (raw as { accepted?: unknown }).accepted : undefined;
    return isNearIntentsRequirements(accepted) ? nearIntents(raw, resource) : intentsTransfer(raw, resource);
  };
}
