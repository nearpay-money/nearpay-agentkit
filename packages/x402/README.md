# @nearpay-money/x402

NearPay's x402 profile for merchants and agents (`nearpay-brain/lld/sdks-and-tools.md` §2): `exact` +
`intents-transfer` on `near:mainnet` (`lld/agentpay.md` §3) and, since 0.2.0, cross-chain `exact` +
`near-intents` (x402 PR #3370 wire shapes, `lld/agentpay.md` §3.1).

## Install

```sh
npm install @nearpay-money/x402 zod     # + hono for @nearpay-money/x402/hono
```

ESM only, Node.js ≥ 22.11. `zod` (^4.6.7) is a peer dependency, `hono` an optional one.

## Merchants: put a price on a route

```ts
import { paywall } from "@nearpay-money/x402"; // Express
import { withPaywall, paymentOf } from "@nearpay-money/x402"; // fetch handlers, Next.js route handlers
import { honoPaywall } from "@nearpay-money/x402/hono"; // Hono

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

### Cross-chain (`near-intents`, 0.2.0)

```ts
paywall(
  {
    amount: "10000",
    origins: [{ asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near" }], // 1–20
    // includeIntentsTransfer: true (default), quoteWindowSeconds: 300 (30–900)
  },
  { secretKey },
);
```

With `origins` the 402 comes from `POST /x402/near-intents/requirements` and lists the `intents-transfer`
entry plus one **unquoted** `near-intents` entry per origin. A `quote` payload → `POST
/x402/near-intents/verify` → a second `402` whose `PAYMENT-REQUIRED` holds the quoted entry (deposit
address, amount, `operationToken`, `refundDeadline`); a quote never serves the resource. A `deposit`
payload → `POST /x402/near-intents/settle` → the handler runs only on `success: true` (the merchant was
paid exactly `amount`); `settlement_pending` → `402` with the pending `PAYMENT-RESPONSE` (cross-chain
delivery takes minutes; the client retries). The facilitator always gets the paywall's own unquoted
entry (remembered per binding; on another replica the locally checked `accepted` entry). Repeats of a
settled operation → `402 exact_near_intents_operation_executed`. `paymentOf(req)` / `res.locals.x402` /
`c.get("x402")` carry `method: "intents-transfer" | "near-intents"`.

## Agents: pay on 402

```ts
import { withX402, decodePaymentResponse } from "@nearpay-money/x402";
import { nearSigner } from "@nearpay-money/agent-signer";

const pay = withX402(fetch, nearSigner({ accountId: "agent.near", keyPair }), {
  maxAmountPerRequest: { "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "50000" },
  allowedPayTo: ["merchant.near"],
});
const res = await pay("https://merchant.example/premium");
decodePaymentResponse(res); // { success, transaction, payer, amount }
```

On `402` it picks the NearPay requirement, enforces the limits on amount + fee (throws
`AgentSignerError` `spend_limit_exceeded` / `pay_to_not_allowed` instead of paying), signs with
`@nearpay-money/agent-signer` and retries once with `PAYMENT-SIGNATURE`. Other 402s are returned untouched.
The Verifier deadline is the requirement's `extra.deadline` (spec 0.1.5) when present, else
`now + maxTimeoutSeconds / 2`. `onPayment({requirements, payload, response, settlement, replayed})`
runs after the paid retry; `replayed: true` means the merchant repeated an earlier settlement of this
payload, so it is not a new debit. Responses and headers are parsed tolerantly: an open-enum value newer
than this version (e.g. an `errorReason`) is kept as received.

### Cross-chain payments (`crossChain`, 0.2.0)

```ts
import { withX402, evmDepositor, resumeX402Operation } from "@nearpay-money/x402";
import { SpendingBudget, rpcIntentsBalanceProvider } from "@nearpay-money/agent-signer";

const pay = withX402(fetch, signer /* or null */, {
  maxAmountPerRequest: { [BASE_USDC]: "1100000", [USDC]: "1100000" }, // origin units for near-intents
  allowedPayTo: ["merchant.near"], // the merchant Intents account (destination.recipient)
  budget: new SpendingBudget({ perCall, perSession }),
  crossChain: {
    originSigner: evmDepositor({ "eip155:8453": viemWalletClient }), // or your own OriginSigner
    store, // durable OperationStore (default: memory)
    balance: rpcIntentsBalanceProvider(), // prefer intents-transfer when the balance covers it
  },
});
```

Order: quote → `checkQuotedEntry` (same binding, network, asset, window, destination; a deposit address,
operation token and ≥ 2 min before `refundDeadline`) → spend limits and budget on the **quoted** amount
→ persist the operation → deposit → persist the `txHash` → retry the deposit payload until a final
result (5 s → 30 s backoff, until `refundDeadline` + 24 h or `maxWaitMs`). An open operation blocks a
second quote for the same resource; `X402ClientError` `settlement_pending` / `deposit_unknown` carry
the `operationId` for `resumeX402Operation`, which never deposits again. `DepositNotSentError` from an
origin signer releases the budget; any other deposit failure counts as spent.

Tests: every adapter runs the full agent → merchant → facilitator loop against a spec-validated fake
facilitator that verifies payloads with the Verifier code agentpay uses; the sandbox E2E lives in
`nearpay-testbed`. License Apache-2.0.

## Links

- Documentation: https://docs.nearpay.money
- Website: https://nearpay.money
- Source and changelog: https://github.com/nearpay-money/nearpay-agentkit

License: Apache-2.0. Earlier versions were named `@nearpay/…` on NearPay's private registry only; NearPay never publishes under the `@nearpay` npm scope (it belongs to an unrelated company).
