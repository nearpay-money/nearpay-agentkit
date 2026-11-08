# Changelog

`@nearpay/x402`, `@nearpay/agent-signer` and `@nearpay/mcp` share one version. Breaking changes bump the
major version and carry a migration note here (semver).

## 0.2.0 — Stage 3, step 3.3 (`@nearpay/spec` 0.3.0)

Includes the step 1.4 changes below (never released on their own). `@nearpay/spec` 0.1.5 → 0.3.0.

- **`@nearpay/mcp` (new).** MCP server, stdio and streamable HTTP (`nearpay-mcp [--http]`). Merchant
  tools `nearpay_create_checkout_session`, `nearpay_get_payment_intent`, `nearpay_list_payments`; payer
  tools `nearpay_pay_checkout_session` (checkout and hosted-invoice URLs), `nearpay_fetch_paid` (x402,
  incl. cross-chain), `nearpay_resume_paid_fetch`, `nearpay_get_spending`. NEP-413 signing with the
  operator's local key; required merchant allow-list; per-call and per-session limits (default 1.00 /
  10.00 of known stablecoins, other assets refused); evidence links on every payment; secrets redacted
  from logs and results; HTTP locked to a bearer token, loopback and a Host allow-list.
- **`@nearpay/x402` cross-chain (`exact` + `near-intents`, x402 PR #3370 shapes).** Paywall option
  `origins` (+ `includeIntentsTransfer`, `quoteWindowSeconds`) issues through
  `/x402/near-intents/requirements` and serves quote → second 402 → deposit → settle; client option
  `crossChain` (`originSigner`, `refundTo`, `origins`, `store`, `balance`, `maxWaitMs`) quotes, checks the
  quoted entry, limits the quoted amount, persists the operation, deposits and redeems with backoff;
  `resumeX402Operation`, `checkQuotedEntry`, `evmDepositor`, `memoryOperationStore`,
  `decodeNearIntentsPaymentResponse`. `withX402` accepts `signer: null` (cross-chain only) and a
  `budget` (`SpendingBudget`).
- **`@nearpay/agent-signer`.** `payInvoice` / `openInvoiceSession` / `parseInvoiceUrl` /
  `parsePaymentUrl` (FR-AGT-05: `/i/<in_…>#<secret>` → `createPublicInvoiceSession` → the checkout
  flow), `submitCheckoutPayment`, `waitForCheckoutOutcome`, `SpendingBudget`, `rpcIntentsBalanceProvider`,
  `toBaseUnits`.
- **Type changes (source-compatible unless you read method-specific fields).** `PaidRequest` and
  `X402PaymentEvent` are unions discriminated by `method` (`"intents-transfer" | "near-intents"`); narrow
  on `method` before reading `payment.payload.signed`. Only paywalls with `origins` / clients with
  `crossChain` ever produce the `near-intents` variant. The facilitator's `nearIntents*` methods are
  optional on the `Facilitator` interface, so custom facilitators written for 0.1 keep compiling (a
  paywall with `origins` requires them).

## Stage 1, step 1.4 (`@nearpay/spec` 0.1.5) — released in 0.2.0

- `@nearpay/agent-signer`: x402 payloads are signed with the requirement's `extra.deadline` when present
  (new `x402LatestDeadline`); requirements without it keep `now + floor(maxTimeoutSeconds / 2)`.
- `@nearpay/x402` paywall: a settle answered with `replayed: true` (settled for an earlier request, e.g.
  by another replica) is refused with `402 requirement_consumed`, so the resource is delivered once per
  settlement. This includes the retry after the request's own `settlement_pending`: pending answers never
  claim the result, so a replayed retry means another request already got it.
- `@nearpay/x402` client: `onPayment` also receives `settlement` (decoded `PAYMENT-RESPONSE`) and
  `replayed`, so a replay is not counted as a new payment.
- Both packages parse API responses and x402 headers with `safeParseTolerant`: unknown open-enum values
  are kept instead of failing the call.

## 0.1.1 — Stage 1, step 1.3

- `@nearpay/x402`: the paywall refuses a replayed `PAYMENT-SIGNATURE` (`402`, `requirement_consumed`)
  for bindings it settled or is settling (in process, 10 min, bounded). The facilitator's settle is
  idempotent on the payload hash, so without this one payment could unlock a resource repeatedly.
  `PaywallOptions.now` added (tests). No API change.

## 0.1.0 — Stage 1, step 1.3

- `@nearpay/agent-signer`: `nearSigner` (NEP-413, raw Ed25519), `evmSigner` (ERC-191, viem-style
  accounts), `buildTransferPayment` / `buildTransferMessage` for x402 requirements and checkout
  `IntentsRequirement`s, `rpcSaltProvider` (`current_salt`, cached 60 s) and `staticSaltProvider`,
  `verifyAttestation` + `parsePinnedKeys` (sentinel co-signatures, pinned keys only),
  `payCheckoutSession` / `prepareCheckoutPayment` (refuse on any mismatch), spend limits.
- `@nearpay/x402`: `createPaywall` with Express (`paywall`), fetch/Next.js (`withPaywall`, `paymentOf`)
  and Hono (`@nearpay/x402/hono`) adapters; facilitator client; agent client `withX402`,
  `decodePaymentResponse`, `parsePaymentRequired`.
