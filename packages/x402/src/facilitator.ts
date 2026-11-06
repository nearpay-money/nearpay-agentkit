/**
 * Client for NearPay's x402 facilitator (lld/agentpay.md §5): `/x402/requirements`, `/x402/verify`,
 * `/x402/settle`, `/x402/supported`, called with the merchant's secret (or restricted) key.
 */
import {
  type AnyRoute,
  API_VERSION,
  ErrorEnvelope,
  HEADERS,
  type RouteBody,
  type RouteResponse,
  x402Requirements,
  x402Settle,
  x402Supported,
  x402Verify,
} from "@nearpay/spec";

export const DEFAULT_API_BASE = "https://api.nearpay.money";

export interface FacilitatorOptions {
  /** Merchant secret key (`sk_live_…`/`sk_test_…`) or restricted key with `agentpay.facilitate`. */
  secretKey: string;
  /** API origin; default `https://api.nearpay.money` (local: `https://api.nearpay.localhost`). */
  apiBase?: string;
  fetch?: typeof fetch;
  /** Per-call timeout; settle waits up to 8 s server-side, so its default is 15 s. */
  timeoutMs?: number;
}

/** The facilitator could not be reached or answered with an error (not an `isValid: false` verdict). */
export class FacilitatorError extends Error {
  constructor(
    message: string,
    /** HTTP status (0 for network errors and timeouts). */
    readonly status: number,
    readonly apiCode?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "FacilitatorError";
  }
}

export type RequirementsRequest = RouteBody<typeof x402Requirements>;
export type PaymentRequiredBody = RouteResponse<typeof x402Requirements>;
export type VerifyRequestBody = RouteBody<typeof x402Verify>;
export type VerifyResponseBody = RouteResponse<typeof x402Verify>;
export type SettleResponseBody = RouteResponse<typeof x402Settle>;
export type SupportedResponseBody = RouteResponse<typeof x402Supported>;

export interface Facilitator {
  requirements(body: RequirementsRequest): Promise<PaymentRequiredBody>;
  verify(body: VerifyRequestBody): Promise<VerifyResponseBody>;
  settle(body: VerifyRequestBody): Promise<SettleResponseBody>;
  supported(): Promise<SupportedResponseBody>;
}

export function facilitator(opts: FacilitatorOptions): Facilitator {
  if (!/^(sk|rk)_(live|test)_/.test(opts.secretKey)) {
    throw new RangeError("secretKey must be a NearPay secret (sk_…) or restricted (rk_…) key");
  }
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const f = opts.fetch ?? fetch;

  async function call(route: AnyRoute, body: unknown, timeoutMs: number): Promise<unknown> {
    let res: Response;
    try {
      res = await f(`${base}${route.path}`, {
        method: route.method,
        headers: {
          accept: "application/json",
          [HEADERS.authorization]: `Bearer ${opts.secretKey}`,
          [HEADERS.apiVersion]: API_VERSION,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
      });
    } catch (e) {
      throw new FacilitatorError(`${route.id}: ${(e as Error).message}`, 0);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // handled below
    }
    if (res.status !== route.status) {
      const env = ErrorEnvelope.safeParse(json);
      throw new FacilitatorError(
        `${route.id} failed (${res.status}${env.success ? ` ${env.data.error.code}: ${env.data.error.message}` : ""})`,
        res.status,
        env.success ? env.data.error.code : undefined,
        env.success ? env.data.error.request_id : (res.headers.get(HEADERS.requestId) ?? undefined),
      );
    }
    const parsed = (route.response as NonNullable<AnyRoute["response"]>).safeParse(json);
    if (!parsed.success) throw new FacilitatorError(`${route.id}: unexpected response body`, res.status);
    return parsed.data;
  }

  return {
    requirements: (body) => call(x402Requirements, body, 10_000) as Promise<PaymentRequiredBody>,
    verify: (body) => call(x402Verify, body, 10_000) as Promise<VerifyResponseBody>,
    settle: (body) => call(x402Settle, body, 15_000) as Promise<SettleResponseBody>,
    supported: () => call(x402Supported, undefined, 10_000) as Promise<SupportedResponseBody>,
  };
}
