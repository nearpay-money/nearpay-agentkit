/**
 * Minimal paid API: `GET /premium` costs 0.01 USDC (10000 base units) paid from a NEAR Intents balance.
 *   NEARPAY_SECRET_KEY=sk_test_… NEARPAY_API_BASE=https://api.nearpay.localhost node --experimental-strip-types server.ts
 */
import { paywall } from "@nearpay/x402";
import express from "express";

const app = express();
app.set("trust proxy", true);
app.get(
  "/premium",
  paywall(
    { amount: "10000", description: "Premium content", mimeType: "application/json" },
    {
      secretKey: process.env.NEARPAY_SECRET_KEY ?? "",
      apiBase: process.env.NEARPAY_API_BASE ?? "https://api.nearpay.money",
      onError: (e) => console.error("x402:", e),
    },
  ),
  (_req, res) => {
    res.json({ content: "the premium content", paid_by: (res.locals.x402 as { payer: string }).payer });
  },
);
app.listen(Number(process.env.PORT ?? 3000));
