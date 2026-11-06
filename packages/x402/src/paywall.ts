/**
 * The x402 paywall, framework-independent (lld/sdks-and-tools.md §2):
 *
 *   no `PAYMENT-SIGNATURE` → `POST /x402/requirements` (one call per 402 response, never cached: each
 *       binding is single-use) → `402` with `PAYMENT-REQUIRED: base64(PaymentRequired)` and body `{}`
 *   header → decode → local checks → `POST /x402/verify` → invalid → `402` + `PAYMENT-RESPONSE` failure
 *       valid → `POST /x402/settle` → success → handler runs, `PAYMENT-RESPONSE: base64(SettleResponse)`
 *       `settlement_pending` → one retry after 1 s, then `402` with the pending response
 *
 * Local checks (defence in depth, the facilitator re-checks everything): the payload must pay this
 * paywall's amount (and asset / payTo / window when configured), and name this resource if it names one.
 * The payload is forwarded with `resource` set to this paywall's resource URL.
 *
 * Replay guard: the facilitator's settle is idempotent on the payload hash (agentpay §7), so a replayed
 * `PAYMENT-SIGNATURE` would get `success` again. The paywall remembers bindings it settled or is
 * settling (in process, 10 min, bounded) and refuses them with `requirement_consumed`. Multi-replica
 * merchants also rely on the facilitator (see brain notes: settle should flag replays).
 */
import {
  BaseUnits,
  decodeX402Header,
  encodeX402Header,
  HEADERS,
  PaymentPayload,
  type PaymentPayload as PaymentPayloadT,
  type SettleResponse,
  X402_NETWORK,
  X402_VERSION,
  type z,
} from "@nearpay/spec";
import { type Facilitator, FacilitatorError, type FacilitatorOptions, facilitator } from "./facilitator.js";

export type SettleResponseT = z.output<typeof SettleResponse>;

export interface PaywallConfig {
  /** Amount the merchant receives, in base units of the asset (e.g. `"10000"` = 0.01 USDC). */
  amount: bigint | string | number;
  /** NEAR Intents asset id; default: the asset of the account's default Intents destination. */
  asset?: string;
  /** Merchant Intents account; default: the account's default Intents destination. */
  payTo?: string;
  description?: string;
  mimeType?: string;
  /** Settlement window, 30–300 s (default 120). */
  maxTimeoutSeconds?: number;
}

/** What the paywall needs from an incoming request. */
export interface PaywallRequest {
  /** Absolute URL of the resource as the client sees it. */
  url: string;
  header(name: string): string | null | undefined;
}

export interface PaidRequest {
  payer: string;
  settlement: SettleResponseT;
  payment: PaymentPayloadT;
  resource: string;
}

export interface PaywallOptions extends FacilitatorOptions {
  /** The resource URL bound into requirements; default: the request URL. */
  resourceUrl?: string | ((req: PaywallRequest) => string);
  /** Delay before the one `settlement_pending` retry (default 1000 ms). */
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

export type PaywallResult =
  | { paid: false; status: number; headers: Record<string, string>; body: unknown }
  | ({ paid: true; headers: Record<string, string> } & PaidRequest);

export type Paywall = (req: PaywallRequest) => Promise<PaywallResult>;

function baseUnits(v: bigint | string | number): string {
  const s = typeof v === "number" ? (Number.isSafeInteger(v) ? String(v) : "x") : String(v);
  if (!BaseUnits.safeParse(s).success || s === "0") {
    throw new RangeError("paywall amount must be a positive integer in base units");
  }
  return s;
}

const settleFailure = (errorReason: string, errorMessage?: string, payer?: string): SettleResponseT => ({
  success: false,
  transaction: "",
  network: X402_NETWORK,
  ...(payer ? { payer } : {}),
  errorReason: errorReason as SettleResponseT["errorReason"],
  ...(errorMessage ? { errorMessage } : {}),
});

export function createPaywall(config: PaywallConfig, opts: PaywallOptions): Paywall {
  const amount = baseUnits(config.amount);
  const window = config.maxTimeoutSeconds;
  if (window !== undefined && (!Number.isInteger(window) || window < 30 || window > 300)) {
    throw new RangeError("maxTimeoutSeconds must be an integer between 30 and 300");
  }
  const fac = opts.facilitator ?? facilitator(opts);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const settledBindings = new Map<string, number>(); // binding → forget after (ms)
  const inflight = new Set<string>();
  const remember = (binding: string) => {
    const t = now();
    if (settledBindings.size >= REPLAY_MAX) {
      for (const [b, until] of settledBindings) if (until <= t) settledBindings.delete(b);
      while (settledBindings.size >= REPLAY_MAX) settledBindings.delete(settledBindings.keys().next().value as string);
    }
    settledBindings.set(binding, t + REPLAY_TTL_MS);
  };
  const seen = (binding: string) => inflight.has(binding) || (settledBindings.get(binding) ?? 0) > now();

  const reject = (s: SettleResponseT): PaywallResult => ({
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

  return async (req) => {
    const resourceUrl = typeof opts.resourceUrl === "function" ? opts.resourceUrl(req) : (opts.resourceUrl ?? req.url);
    const resource = {
      url: resourceUrl,
      ...(config.description ? { description: config.description } : {}),
      ...(config.mimeType ? { mimeType: config.mimeType } : {}),
    };
    const header = req.header(HEADERS.x402PaymentSignature);

    if (!header) {
      try {
        const required = await fac.requirements({
          resource,
          amount,
          ...(config.asset ? { asset_id: config.asset } : {}),
          ...(config.payTo ? { pay_to: config.payTo } : {}),
          ...(window ? { max_timeout_s: window } : {}),
        });
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

    let payment: PaymentPayloadT;
    try {
      payment = PaymentPayload.parse(decodeX402Header(header));
    } catch {
      return reject(settleFailure("invalid_payload", "PAYMENT-SIGNATURE is not a NearPay x402 payment payload"));
    }
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
              : payment.resource && payment.resource.url !== resourceUrl
                ? "resource"
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
      const paid: PaidRequest = {
        payer: s.payer ?? verdict.payer ?? "",
        settlement: s,
        payment,
        resource: resourceUrl,
      };
      opts.onSettled?.(paid);
      return { paid: true, headers: { [HEADERS.x402PaymentResponse]: encodeX402Header(s) }, ...paid };
    } catch (e) {
      return unavailable(e);
    } finally {
      inflight.delete(binding);
    }
  };
}
