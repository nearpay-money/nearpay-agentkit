/**
 * Express (and Connect-style) middleware: `app.get("/premium", paywall({amount: "10000"}, {secretKey}), handler)`.
 * The paid request carries the settlement in `res.locals.x402` and the response gets `PAYMENT-RESPONSE`.
 */
import { createPaywall, type PaidRequest, type PaywallConfig, type PaywallOptions } from "./paywall.js";

/** The parts of an Express request the paywall reads. */
export interface ExpressLikeRequest {
  protocol: string;
  originalUrl: string;
  get(name: string): string | undefined;
}

/** The parts of an Express response the paywall writes. */
export interface ExpressLikeResponse {
  locals: Record<string, unknown>;
  status(code: number): ExpressLikeResponse;
  set(headers: Record<string, string>): ExpressLikeResponse;
  json(body: unknown): unknown;
}

export type ExpressNext = (err?: unknown) => void;

/** Default resource URL: `<protocol>://<host><originalUrl>` (set `trust proxy` behind a proxy, or pass `resourceUrl`). */
export function expressResourceUrl(req: ExpressLikeRequest): string {
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

export function paywall(config: PaywallConfig, opts: PaywallOptions) {
  const run = createPaywall(config, opts);
  return async (req: ExpressLikeRequest, res: ExpressLikeResponse, next: ExpressNext): Promise<void> => {
    try {
      const out = await run({ url: expressResourceUrl(req), header: (n) => req.get(n) });
      if (!out.paid) {
        res.status(out.status).set(out.headers).json(out.body);
        return;
      }
      res.set(out.headers);
      const { payer, settlement, payment, resource } = out;
      res.locals.x402 = { payer, settlement, payment, resource } satisfies PaidRequest;
      next();
    } catch (e) {
      next(e);
    }
  };
}
