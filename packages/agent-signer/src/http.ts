/** Minimal client for the public payer/sentinel routes this package calls, driven by the spec route tables. */
import { type AnyRoute, API_VERSION, ErrorEnvelope, HEADERS, safeParseTolerant } from "@nearpay-money/spec";
import { AgentSignerError } from "./errors.js";

export interface CallOptions {
  base: string;
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ApiCallError extends AgentSignerError {
  constructor(
    message: string,
    readonly status: number,
    readonly apiCode: string | undefined,
    requestId: string | undefined,
  ) {
    super("api_error", message, { status, ...(apiCode ? { apiCode } : {}), ...(requestId ? { requestId } : {}) });
    this.name = "ApiCallError";
  }
}

export function routePath(route: AnyRoute, params: Record<string, string> = {}): string {
  return route.path.replace(/\{([a-z_]+)\}/g, (_m, k: string) => {
    const v = params[k];
    if (v === undefined) throw new RangeError(`missing path parameter ${k}`);
    return encodeURIComponent(v);
  });
}

/**
 * Calls a spec route; returns the body parsed with the route's response schema (`data`) and the raw
 * JSON as received (`json`, for signature checks over exactly what the server sent).
 */
export async function callRoute(route: AnyRoute, o: CallOptions): Promise<{ data: unknown; json: unknown }> {
  const url = `${o.base.replace(/\/$/, "")}${routePath(route, o.params)}`;
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      method: route.method,
      headers: {
        accept: "application/json",
        [HEADERS.apiVersion]: API_VERSION,
        ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        ...o.headers,
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new ApiCallError(`${route.id}: ${(e as Error).message}`, 0, undefined, undefined);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON; handled below
  }
  if (res.status !== route.status) {
    const env = ErrorEnvelope.safeParse(json);
    const code = env.success ? env.data.error.code : undefined;
    const msg = env.success ? env.data.error.message : text.slice(0, 200);
    throw new ApiCallError(
      `${route.id} failed (${res.status}${code ? ` ${code}` : ""}): ${msg}`,
      res.status,
      code,
      env.success ? env.data.error.request_id : (res.headers.get(HEADERS.requestId) ?? undefined),
    );
  }
  if (!route.response) return { data: undefined, json };
  // Tolerant (spec 0.1.5): unknown values of open enums (statuses, reasons) are kept, not refused.
  const parsed = safeParseTolerant(route.response, json);
  if (!parsed.success) {
    throw new ApiCallError(`${route.id}: unexpected response body`, res.status, undefined, undefined);
  }
  return { data: parsed.data, json };
}
