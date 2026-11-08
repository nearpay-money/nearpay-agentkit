/**
 * Merchant API calls for the merchant tools, driven by the spec route tables (`@nearpay/spec`): the
 * configured secret/restricted key, `NearPay-Version`, an `Idempotency-Key` on every POST (reused on
 * retries), tolerant response parsing. Retries: 429 and `idempotency_in_progress` for any route; network
 * errors and 5xx only for replay-safe routes (GET, `idempotent: true`) — the same policy as `@nearpay/node`.
 * (agentkit depends on the spec only, so the three routes are called directly instead of through the
 * node SDK; lld/sdks-and-tools.md §2.)
 */
import { randomUUID } from "node:crypto";
import { type AnyRoute, API_VERSION, ErrorEnvelope, HEADERS, safeParseTolerant } from "@nearpay/spec";

export class NearPayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = "NearPayApiError";
  }
}

export interface MerchantClientOptions {
  apiKey: string;
  apiBase: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MerchantCall {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
}

export interface MerchantClient {
  call<T = unknown>(
    route: AnyRoute,
    c?: MerchantCall,
  ): Promise<{ data: T; requestId?: string; idempotencyKey?: string }>;
}

function path(route: AnyRoute, params: Record<string, string> = {}): string {
  return route.path.replace(/\{([a-z_]+)\}/g, (_m, k: string) => {
    const v = params[k];
    if (v === undefined) throw new RangeError(`missing path parameter ${k}`);
    return encodeURIComponent(v);
  });
}

function search(query: Record<string, unknown> = {}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) sp.append(`${k}[]`, String(x));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function merchantClient(o: MerchantClientOptions): MerchantClient {
  if (!/^(sk|rk)_(live|test)_[0-9A-Za-z]+$/.test(o.apiKey)) {
    throw new RangeError("apiKey must be a NearPay secret (sk_…) or restricted (rk_…) key");
  }
  const base = o.apiBase.replace(/\/$/, "");
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = o.maxRetries ?? 2;

  return {
    async call(route, c = {}) {
      const replaySafe = route.method === "GET" || route.method === "DELETE" || route.idempotent === true;
      const key = route.method === "POST" ? (c.idempotencyKey ?? randomUUID()) : undefined;
      const url = `${base}${path(route, c.params)}${search(c.query)}`;
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await f(url, {
            method: route.method,
            headers: {
              accept: "application/json",
              [HEADERS.authorization]: `Bearer ${o.apiKey}`,
              [HEADERS.apiVersion]: API_VERSION,
              ...(key ? { [HEADERS.idempotencyKey]: key } : {}),
              ...(c.body !== undefined ? { "content-type": "application/json" } : {}),
            },
            ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
            signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
          });
        } catch (e) {
          if (replaySafe && attempt < maxRetries) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new NearPayApiError(`${route.id}: ${(e as Error).message}`, 0, undefined, undefined);
        }
        const text = await res.text();
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          // not JSON: handled below
        }
        const requestId = res.headers.get(HEADERS.requestId) ?? undefined;
        if (res.status === route.status) {
          const parsed = route.response
            ? safeParseTolerant(route.response, json)
            : { success: true as const, data: json };
          if (!parsed.success) throw new NearPayApiError(`${route.id}: unexpected response body`, res.status);
          return {
            data: parsed.data as never,
            ...(requestId ? { requestId } : {}),
            ...(key ? { idempotencyKey: key } : {}),
          };
        }
        const env = ErrorEnvelope.safeParse(json);
        const code = env.success ? env.data.error.code : undefined;
        const retryable = res.status === 429 || code === "idempotency_in_progress" || (replaySafe && res.status >= 500);
        if (retryable && attempt < maxRetries) {
          const after = Number(res.headers.get(HEADERS.retryAfter));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 8) * 1000 : 500 * 2 ** attempt);
          continue;
        }
        throw new NearPayApiError(
          `${route.id} failed (${res.status}${code ? ` ${code}` : ""}): ${env.success ? env.data.error.message : text.slice(0, 200)}`,
          res.status,
          code,
          env.success ? env.data.error.request_id : requestId,
          env.success ? env.data.error.param : undefined,
        );
      }
    },
  };
}
