# Changelog

`@nearpay/x402` and `@nearpay/agent-signer` share one version. Breaking changes bump the major version
and carry a migration note here (semver).

## 0.1.0 — Stage 1, step 1.3

- `@nearpay/agent-signer`: `nearSigner` (NEP-413, raw Ed25519), `evmSigner` (ERC-191, viem-style
  accounts), `buildTransferPayment` / `buildTransferMessage` for x402 requirements and checkout
  `IntentsRequirement`s, `rpcSaltProvider` (`current_salt`, cached 60 s) and `staticSaltProvider`,
  `verifyAttestation` + `parsePinnedKeys` (sentinel co-signatures, pinned keys only),
  `payCheckoutSession` / `prepareCheckoutPayment` (refuse on any mismatch), spend limits.
- `@nearpay/x402`: `createPaywall` with Express (`paywall`), fetch/Next.js (`withPaywall`, `paymentOf`)
  and Hono (`@nearpay/x402/hono`) adapters; facilitator client; agent client `withX402`,
  `decodePaymentResponse`, `parsePaymentRequired`.
