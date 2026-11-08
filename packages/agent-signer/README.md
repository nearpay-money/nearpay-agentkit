# @nearpay/agent-signer

Sign NearPay NEAR Intents transfers for AI agents and scripts: the payer-side half of NearPay's agent
payments (`nearpay-brain/lld/sdks-and-tools.md` §2). NearPay never holds the key; it only relays what
you signed (INV-1).

```ts
import {
  nearSigner,
  evmSigner,
  buildTransferPayment,
  payCheckoutSession,
  parsePinnedKeys,
} from "@nearpay/agent-signer";

// NEP-413 (NEAR key) — or evmSigner(privateKeyToAccount(…)) for ERC-191 with an EVM key
const signer = nearSigner({ accountId: "agent.near", keyPair: "ed25519:…" });

// x402: sign exactly the two transfers a requirement asks for (merchant + NearPay fee, memo = binding)
const signed = await buildTransferPayment(paymentRequirements, signer); // → MultiPayload

// Checkout session: verified by sentinel with pinned keys before anything is signed
const { prepared, submission } = await payCheckoutSession(
  { url: "https://pay.nearpay.money/c/cs_…#cs_…_secret_…" },
  signer,
  { pinnedKeys: parsePinnedKeys(sentinelKeysJson), maxAmount: { "nep141:…usdc…": "2500000" } },
);
```

## API

| Export                                                                        | What it does                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nearSigner({accountId?, keyPair, standard?})`                                | NEP-413 signer (default) or `raw_ed25519`; `keyPair` = `ed25519:<base58>` secret, 32-byte seed or a near-api-js `KeyPair`. `accountId` defaults to the implicit account.                                                                                            |
| `evmSigner(account)`                                                          | ERC-191 signer for a viem-style account (`address`, `signMessage`); `signer_id` = lower-case eth-implicit account; signature normalised to r‖s‖v, v ∈ {0,1}, low s, and checked to recover to the account.                                                          |
| `buildTransferPayment(requirements, signer, {nonceSaltProvider?, deadline?})` | Accepts an x402 `PaymentRequirements` (`exact` + `intents-transfer`) or a checkout `IntentsRequirement`; returns the `MultiPayload`. Nonce = `current_salt` ‖ 28 random bytes.                                                                                      |
| `rpcSaltProvider({rpcUrls?})` / `staticSaltProvider(hex)`                     | `current_salt` of `intents.near` over NEAR RPC, cached 60 s (default) / a fixed salt (tests; the sandbox Verifier accepts any).                                                                                                                                     |
| `payCheckoutSession(target, signer, opts)` / `prepareCheckoutPayment`         | requirements → sentinel attestation → verify (pinned key, `kid` allow-list, every field equal, unexpired) → sign → submit. Refuses with `AgentSignerError` on any mismatch.                                                                                         |
| `verifyAttestation(signed, expected, {pinnedKeys})`                           | The co-signature check on its own (both `intents_transfer` and `route_quote`).                                                                                                                                                                                      |
| `parsePinnedKeys(json)` / `PINNED_SENTINEL_KEYS`                              | Reads `sentinel_keys.json` (`[{kid, public_key}]`). The shipped set is empty in 0.1.x: sentinel keys are generated per stack in Stages 1–4, so operators pin theirs. Keys are never fetched from the API.                                                           |
| `enforceSpendPolicy` / `SpendLimit`                                           | Limits on amount + fee (base units, one value or per asset id) and allowed recipients.                                                                                                                                                                              |
| `payInvoice(target, signer, opts)` / `openInvoiceSession` / `parseInvoiceUrl` | Hosted invoice `…/i/<in_…>#<invoice secret>`: `getPublicInvoice` (refused unless `payable` and of the agent's mode) → `createPublicInvoiceSession` (`X-NearPay-Invoice-Secret`) → the checkout flow above. `parsePaymentUrl` tells checkout and invoice URLs apart. |
| `submitCheckoutPayment` / `waitForCheckoutOutcome`                            | Submit a prepared payment separately (a 4xx means nothing was queued); poll the public session until the payment is final.                                                                                                                                          |
| `SpendingBudget({perCall, perSession})`                                       | Session budget per asset: `reserve(asset, amount)` checks both limits counting committed and reserved amounts, then `commit()` (money moved or may have) or `release()` (refused before signing/sending).                                                           |
| `rpcIntentsBalanceProvider({rpcUrls?})`                                       | The signer's NEAR Intents balance (`mt_balance_of`), used by `@nearpay/x402` to prefer `intents-transfer` over a cross-chain deposit.                                                                                                                               |

**x402 deadlines.** Since spec 0.1.5 a requirement carries its absolute expiry `extra.deadline` (the
binding's `expires_at`); payloads are signed with that deadline (`x402LatestDeadline`), at or before it
whatever the local clock says. Requirements from older facilitators carry only `maxTimeoutSeconds` from
issue, so payloads then use half of that window (`x402DeadlineSeconds`) to stay inside the facilitator's
`(now + 5 s, issued_at + maxTimeoutSeconds]` range despite the 402 round trip and clock skew.

**Tolerant parsing.** API responses are parsed with the spec's `safeParseTolerant`: a value of an open
enum (an attempt status, a reason) newer than this version is kept, not refused. Sentinel attestations
stay strictly validated (they contain no open enums) before their signature is checked.

## Tests

Signatures are byte-identical to `@nearpay/spec/test-vectors/intents-payloads.json` (NEP-413, ERC-191
via viem, raw Ed25519) and verify with the Verifier code agentpay and the sandbox use; attestation
checks run against `sentinel-attestation.json`; checkout payments run against a spec-driven fake API.

Design: `nearpay-brain/lld/sdks-and-tools.md` §2, `lld/agentpay.md` §3/§5, foundations §14. License Apache-2.0.
