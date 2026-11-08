/**
 * An in-process, spec-validating mock of NearPay public routes (a `fetch` implementation; no ports).
 * Every request is matched to a route of `PUBLIC_ROUTES` and checked like the gateway and the service
 * bootstrap check it: credentials allowed by the route's `auth`, `NearPay-Version`, an
 * `Idempotency-Key` on `idempotent: true` POSTs, route headers, and path params, query and body parsed
 * **strictly** with the route's schemas. Violations answer `400 invalid_request` and are recorded
 * (tests assert none). Handler results are validated against the route's response schema.
 */
import { type AnyRoute, API_VERSION, ERRORS, type ErrorCode, ErrorEnvelope, PUBLIC_ROUTES, z } from "@nearpay/spec";

export interface MockRequest {
  route: AnyRoute;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  headers: Headers;
  idempotencyKey: string | null;
}

/** Returns the response body (validated against the route's schema) or `{$status, $body?, $headers?}`. */
export type MockHandler = (req: MockRequest) => unknown;

export class MockApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status?: number,
  ) {
    super(code);
  }
}

export function envelope(code: ErrorCode): unknown {
  const def = ERRORS[code];
  return ErrorEnvelope.parse({
    error: {
      type: def.type,
      code,
      message: def.example,
      doc_url: `https://docs.nearpay.money/errors/${code}`,
      request_id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
    },
  });
}

const compile = (route: AnyRoute) => {
  const names: string[] = [];
  const src = route.path
    .split("/")
    .map((seg) => {
      const m = /^\{([a-z_]+)\}$/.exec(seg);
      if (m) {
        names.push(m[1] as string);
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { route, names, re: new RegExp(`^${src}$`) };
};
const TABLE = PUBLIC_ROUTES.map(compile);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_01jbz9k3m4n5p6q7r8s9t0v1w2", ...headers },
  });

export function specMock(opts: { base?: string } = {}) {
  const base = opts.base ?? "https://api.test";
  const handlers = new Map<string, MockHandler>();
  const once = new Map<string, Response[]>();
  const calls: MockRequest[] = [];
  const violations: string[] = [];
  const attempts: { route: string; idempotencyKey: string | null }[] = [];

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    if (url.origin !== base) throw new TypeError(`mock: unexpected origin ${url.origin}`);
    const method = req.method;
    const hit = TABLE.map((t) => ({ t, m: t.route.method === method ? t.re.exec(url.pathname) : null })).find(
      (x) => x.m,
    );
    const v = (problem: string) => {
      violations.push(`${method} ${url.pathname}: ${problem}`);
      return json(400, envelope("invalid_request"));
    };
    if (!hit?.m) return v("no such route");
    const route = hit.t.route;
    attempts.push({ route: route.id, idempotencyKey: req.headers.get("idempotency-key") });
    const auth = req.headers.get("authorization");
    if (route.auth.every((a) => a === "anonymous" || a === "client_secret")) {
      if (auth !== null) return v("payer/anonymous routes must not carry Authorization");
    } else {
      const key = /^Bearer ((sk|rk)_(test|live)_[0-9A-Za-z]+)$/.exec(auth ?? "");
      if (!key) return v("missing or malformed Bearer key");
      if (key[2] === "sk" && !route.auth.includes("secret_key")) return json(403, envelope("permission_denied"));
      if (key[2] === "rk" && !route.auth.some((a) => a.startsWith("restricted_key:"))) {
        return json(403, envelope("permission_denied"));
      }
    }
    if (req.headers.get("nearpay-version") !== API_VERSION) return v("NearPay-Version missing or not pinned");
    const idem = req.headers.get("idempotency-key");
    if (route.idempotent === true && method === "POST" && !idem) return v("Idempotency-Key missing");
    if (idem && idem.length > 255) return v("Idempotency-Key too long");
    if (route.headers instanceof z.ZodObject) {
      const picked = Object.fromEntries(
        Object.keys(route.headers.shape).flatMap((k) => (req.headers.get(k) === null ? [] : [[k, req.headers.get(k)]])),
      );
      const h = route.headers.safeParse(picked);
      if (!h.success) return v(`headers: ${h.error.issues[0]?.message}`);
    }
    const params = Object.fromEntries(hit.t.names.map((n, i) => [n, decodeURIComponent(hit.m?.[i + 1] ?? "")]));
    if (route.params) {
      const p = route.params.safeParse(params);
      if (!p.success) return v(`params: ${p.error.issues[0]?.message}`);
    }
    const qObj: Record<string, unknown> = {};
    for (const [k, val] of url.searchParams) qObj[k] = val;
    let query: Record<string, unknown> = {};
    if (route.query) {
      const q = route.query.safeParse(qObj);
      if (!q.success) return v(`query: ${JSON.stringify(q.error.issues[0])}`);
      query = q.data as Record<string, unknown>;
    } else if (Object.keys(qObj).length > 0) return v("query on a route without one");
    let body: unknown;
    const raw = await req.text();
    if (method === "GET" || method === "DELETE") {
      if (raw !== "") return v(`${method} with a body`);
    } else if (route.body) {
      if (req.headers.get("content-type") !== "application/json") return v("Content-Type must be application/json");
      const b = route.body.safeParse(JSON.parse(raw));
      if (!b.success) return v(`body: ${JSON.stringify(b.error.issues[0])}`);
      body = b.data;
    }
    const queued = once.get(route.id)?.shift();
    if (queued) return queued;
    const mreq: MockRequest = { route, params, query, body, headers: req.headers, idempotencyKey: idem };
    calls.push(mreq);
    const handler = handlers.get(route.id);
    if (!handler) return v("route not mocked");
    let reply: unknown;
    try {
      reply = await handler(mreq);
    } catch (e) {
      if (e instanceof MockApiError) return json(e.status ?? ERRORS[e.code].status, envelope(e.code));
      throw e;
    }
    if (reply && typeof reply === "object" && "$status" in reply) {
      const r = reply as { $status: number; $body?: unknown; $headers?: Record<string, string> };
      return json(r.$status, r.$body, r.$headers);
    }
    if (route.response) {
      const parsed = route.response.safeParse(reply);
      if (!parsed.success) {
        violations.push(`${route.id}: mock response breaks the spec: ${JSON.stringify(parsed.error.issues[0])}`);
        return json(500, envelope("api_error"));
      }
    }
    return json(route.status, reply);
  }) as typeof globalThis.fetch;

  return {
    base,
    fetch,
    calls,
    violations,
    attempts,
    on(route: AnyRoute, h: MockHandler) {
      handlers.set(route.id, h);
      return this;
    },
    once(route: AnyRoute, res: Response) {
      once.set(route.id, [...(once.get(route.id) ?? []), res]);
      return this;
    },
  };
}
