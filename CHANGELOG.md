# Changelog

`@nearpay/x402` and `@nearpay/agent-signer` share one version. Breaking changes bump the major version
and carry a migration note here (semver).

## Unreleased — Stage 1, step 1.4 (`@nearpay/spec` 0.1.5)

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
