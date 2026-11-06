/**
 * Hono middleware (`@nearpay/x402/hono`): `app.use("/premium", honoPaywall({amount: "10000"}, {secretKey}))`.
 * The paid request carries the settlement in `c.get("x402")`; the response gets `PAYMENT-RESPONSE`.
 */
import type { MiddlewareHandler } from "hono";
import { createPaywall, type PaidRequest, type PaywallConfig, type PaywallOptions } from "./paywall.js";

export type { PaidRequest, PaywallConfig, PaywallOptions } from "./paywall.js";

export function honoPaywall(
  config: PaywallConfig,
  opts: PaywallOptions,
): MiddlewareHandler<{ Variables: { x402: PaidRequest } }> {
  const run = createPaywall(config, opts);
  return async (c, next) => {
    const out = await run({ url: c.req.url, header: (n) => c.req.header(n) });
    if (!out.paid) {
      return new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { "content-type": "application/json", ...out.headers },
      });
    }
    const { payer, settlement, payment, resource } = out;
    c.set("x402", { payer, settlement, payment, resource });
    await next();
    for (const [k, v] of Object.entries(out.headers)) c.res.headers.set(k, v);
  };
}
