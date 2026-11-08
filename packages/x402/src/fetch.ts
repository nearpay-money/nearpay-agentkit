/**
 * Fetch-API handlers (Next.js route handlers, Bun, Deno, Cloudflare Workers, Hono `app.get` handlers):
 * `export const GET = withPaywall(handler, {amount: "10000"}, {secretKey})`. The handler runs only
 * after settlement; `paymentOf(request)` returns the settlement inside it.
 */
import { createPaywall, type PaidRequest, type PaywallConfig, type PaywallOptions, paidRequestOf } from "./paywall.js";

const paid = new WeakMap<Request, PaidRequest>();

/** The settlement of a request that passed a `withPaywall` paywall. */
export function paymentOf(req: Request): PaidRequest | undefined {
  return paid.get(req);
}

export function withPaywall<A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Response | Promise<Response>,
  config: PaywallConfig,
  opts: PaywallOptions,
): (req: Request, ...rest: A) => Promise<Response> {
  const run = createPaywall(config, opts);
  return async (req, ...rest) => {
    const out = await run({ url: req.url, header: (n) => req.headers.get(n) });
    if (!out.paid) {
      return new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { "content-type": "application/json", ...out.headers },
      });
    }
    paid.set(req, paidRequestOf(out));
    const res = await handler(req, ...rest);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(out.headers)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
