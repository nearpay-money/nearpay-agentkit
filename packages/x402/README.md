# @nearpay/x402

NearPay's x402 profile (`exact` + `intents-transfer` on `near:mainnet`) for merchants and agents
(`nearpay-brain/lld/sdks-and-tools.md` §2, `lld/agentpay.md` §3).

## Merchants: put a price on a route

```ts
import { paywall } from "@nearpay/x402"; // Express
import { withPaywall, paymentOf } from "@nearpay/x402"; // fetch handlers, Next.js route handlers
import { honoPaywall } from "@nearpay/x402/hono"; // Hono

app.get(
  "/premium",
  paywall({ amount: "10000", description: "Premium" }, { secretKey: process.env.NEARPAY_SECRET_KEY }),
  (req, res) => res.json({ content: "…", paidBy: res.locals.x402.payer }),
);

export const GET = withPaywall(
  (req) => Response.json({ paidBy: paymentOf(req)?.payer }),
  { amount: "10000" },
  { secretKey },
);
```

- No `PAYMENT-SIGNATURE` → one `POST /x402/requirements` per 402 response (bindings are single-use;
  never cached) → `402`, `PAYMENT-REQUIRED: base64(PaymentRequired)`, body `{}`.
- With a payment → local checks (amount, and asset / payTo / window when configured, resource URL) →
  `POST /x402/verify` → invalid: `402` + `PAYMENT-RESPONSE` failure; valid → `POST /x402/settle` →
  success: the handler runs and the response carries `PAYMENT-RESPONSE: base64(SettleResponse)`;
  `settlement_pending` → one retry after 1 s, then `402` with the pending response.
- A replayed `PAYMENT-SIGNATURE` (binding already settled by this process, 10 min memory) → `402`
  `requirement_consumed`; settle upstream is idempotent, so this keeps one payment = one delivery.
  Across replicas (or after the 10 min) the facilitator flags the repeat with `SettleResponse.replayed`
  (spec 0.1.5) and the paywall refuses it the same way, without running the handler or `onSettled`. No
  exception after this request's own `settlement_pending`: pending answers never claim the result, so a
  replayed retry means another request (e.g. a second replica) already got it.
- Facilitator unreachable or 5xx → `503` (`Retry-After: 1`); facilitator 4xx (e.g. `account_not_live`)
  → `500 payment_misconfigured`. `onError` receives the cause.
- Options: `secretKey` (`sk_…` or `rk_…` with `agentpay.facilitate`), `apiBase` (default
  `https://api.nearpay.money`), `resourceUrl` (string or function; set it behind proxies), `onSettled`.

## Agents: pay on 402

```ts
import { withX402, decodePaymentResponse } from "@nearpay/x402";
import { nearSigner } from "@nearpay/agent-signer";

const pay = withX402(fetch, nearSigner({ accountId: "agent.near", keyPair }), {
  maxAmountPerRequest: { "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "50000" },
  allowedPayTo: ["merchant.near"],
});
const res = await pay("https://merchant.example/premium");
decodePaymentResponse(res); // { success, transaction, payer, amount }
```

On `402` it picks the NearPay requirement, enforces the limits on amount + fee (throws
`AgentSignerError` `spend_limit_exceeded` / `pay_to_not_allowed` instead of paying), signs with
`@nearpay/agent-signer` and retries once with `PAYMENT-SIGNATURE`. Other 402s are returned untouched.
The Verifier deadline is the requirement's `extra.deadline` (spec 0.1.5) when present, else
`now + maxTimeoutSeconds / 2`. `onPayment({requirements, payload, response, settlement, replayed})`
runs after the paid retry; `replayed: true` means the merchant repeated an earlier settlement of this
payload, so it is not a new debit. Responses and headers are parsed tolerantly: an open-enum value newer
than this version (e.g. an `errorReason`) is kept as received.

Tests: every adapter runs the full agent → merchant → facilitator loop against a spec-validated fake
facilitator that verifies payloads with the Verifier code agentpay uses; the sandbox E2E lives in
`nearpay-testbed`. License Apache-2.0.
