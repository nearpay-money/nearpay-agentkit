/**
 * Minimal paid API: `GET /premium` costs 0.01 USDC (10000 base units), paid from a NEAR Intents balance
 * or — with NEARPAY_ORIGINS set — cross-chain (`near-intents`): the agent deposits on an origin chain and
 * 1Click delivers exactly 0.01 USDC to the merchant's NEAR Intents account.
 *   NEARPAY_SECRET_KEY=sk_test_… NEARPAY_API_BASE=https://api.nearpay.localhost \
 *   NEARPAY_ORIGINS=nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near \
 *   node --experimental-strip-types server.ts
 */
import { type PaidRequest, paywall } from "@nearpay-money/x402";
import express from "express";

const origins = (process.env.NEARPAY_ORIGINS ?? "")
  .split(",")
  .filter(Boolean)
  .map((asset_id) => ({ asset_id }));

const app = express();
app.set("trust proxy", true);
app.get(
  "/premium",
  paywall(
    {
      amount: "10000",
      description: "Premium content",
      mimeType: "application/json",
      ...(origins.length > 0 ? { origins } : {}),
    },
    {
      secretKey: process.env.NEARPAY_SECRET_KEY ?? "",
      apiBase: process.env.NEARPAY_API_BASE ?? "https://api.nearpay.money",
      onError: (e) => console.error("x402:", e),
    },
  ),
  (_req, res) => {
    const paid = res.locals.x402 as PaidRequest;
    res.json({ content: "the premium content", paid_by: paid.payer, method: paid.method });
  },
);
app.listen(Number(process.env.PORT ?? 3000));
