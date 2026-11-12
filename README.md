# nearpay-agentkit

Agent payments toolkit: x402 paywall middleware (Express, Hono, Next.js) and agent client, an MCP server for agents, and NEAR Intents signing helpers.

Part of [NearPay](https://github.com/nearpay-money/nearpay) — start there for the live demo, the architecture diagram and the full "do X, see Y" walkthrough.

- **Where it sits:** a merchant's server uses `@nearpay-money/x402` to charge for an HTTP resource; an AI agent uses `@nearpay-money/agent-signer`, the x402 client or the `nearpay-mcp` server to pay. All three talk to NearPay's agentpay service (the x402 facilitator and relay) and the public API at https://api.nearpay.money. They depend only on `@nearpay-money/spec`.
- **Status:** published on npm: [`@nearpay-money/x402`](https://www.npmjs.com/package/@nearpay-money/x402), [`@nearpay-money/agent-signer`](https://www.npmjs.com/package/@nearpay-money/agent-signer) and [`@nearpay-money/mcp`](https://www.npmjs.com/package/@nearpay-money/mcp), all 0.3.0. NearPay runs on NEAR mainnet as a closed beta (https://nearpay.money).

|                                       |                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------- |
| Group                                 | SDKs & tools                                                              |
| Kind                                  | library                                                                   |
| Ships as                              | npm: @nearpay-money/x402, @nearpay-money/mcp, @nearpay-money/agent-signer |
| Owns                                  | Agent SDKs                                                                |
| Depends on (published artifacts only) | spec (public)                                                             |
| First built in                        | Stage 1 (step 1.3)                                                        |

## Documentation

Design docs live in [`nearpay-brain`](https://github.com/nearpay-money/nearpay-brain), not here.

- [`lld/sdks-and-tools.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/sdks-and-tools.md) — low-level design this repo is implemented from
- [`lld/audits/sdks-and-tools.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/audits/sdks-and-tools.md) — audit findings already folded into the LLD
- [`roadmap/development-plan.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/roadmap/development-plan.md) — stage and step this repo is built in
- [`architecture/hld.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/hld.md) — system design
- [`architecture/repositories.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/repositories.md) — repo topology and dependency rules
- [`decisions/ADR-0009-agent-payments-x402.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/decisions/ADR-0009-agent-payments-x402.md)

## Packages

| Package                                                          | Version | What                                                                                                                          |
| ---------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`@nearpay-money/x402`](packages/x402/README.md)                 | 0.3.0   | Paywall middleware (Express, Hono, fetch / Next.js) and the agent client `withX402`; cross-chain `near-intents` on both sides |
| [`@nearpay-money/agent-signer`](packages/agent-signer/README.md) | 0.3.0   | NEP-413 / ERC-191 signers, `buildTransferPayment`, sentinel-verified `payCheckoutSession`, `payInvoice`, `SpendingBudget`     |
| [`@nearpay-money/mcp`](packages/mcp/README.md)                   | 0.3.0   | MCP server (stdio + streamable HTTP): merchant tools and payer tools with limits, a merchant allow-list and evidence links    |

All depend only on `@nearpay-money/spec` (public); `@nearpay-money/mcp` adds the MCP SDK (and optionally viem). Signatures are byte-identical to
`nearpay-spec/test-vectors/intents-payloads.json`; checkout payments are signed only after the
sentinel co-signature verifies with a pinned key.

## Layout

```
nearpay-agentkit/
├── packages/
│   ├── agent-signer/     src: signers, payment (MultiPayload), salt, attestation, checkout, limits, http
│   ├── x402/             src: paywall (core), express, fetch (Next), hono, facilitator, client (withX402)
│   └── mcp/              src: server (tools), config, merchant, transports (stdio/HTTP), store, evidence, redact, evm, bin
├── examples/
│   ├── express/          paid `GET /premium` (optionally cross-chain)
│   ├── agent/            agent paying it with withX402
│   └── mcp-agent/        agent driving nearpay-mcp over stdio
├── scripts/
│   ├── build-package.mjs tsc → dist (ESM + d.ts)
│   └── release-local.mjs publish to the local registry (loopback Verdaccio only, reproducible tarballs)
└── .github/
```

## Verify this repo

Needs Node 22 (`.nvmrc`) and pnpm 9. No Docker. `.npmrc` points the `@nearpay-money` and `@nearpay-internal` scopes at a local package registry, so start that first.

1. Start the local registry (no Docker, Node 22 only):
   `git clone https://github.com/nearpay-money/nearpay-deploy ../nearpay-deploy && ../nearpay-deploy/scripts/registry.sh start`
   → `curl http://127.0.0.1:4873/-/ping` answers `{}`.
2. `pnpm install --frozen-lockfile` → ends with `Done in …`, no registry errors.
3. `pnpm test` (unit, test-vector and property tests, plus integration against spec-validating mocks) → `Test Files  23 passed (23)`, `Tests  244 passed (244)`.
4. `pnpm verify` (the full gate: typecheck, lint, the same tests with the coverage gate of ≥ 90 % branches and lines, build of the three packages) → exits 0. It needs nothing beyond steps 1–2.

The published packages can also be checked without a clone: `npm install @nearpay-money/x402 @nearpay-money/agent-signer @nearpay-money/mcp` in an empty directory installs version 0.3.0 of each from npmjs.com. The end-to-end run against the sandbox lives in [nearpay-testbed](https://github.com/nearpay-money/nearpay-testbed).

## Develop

```sh
pnpm install --frozen-lockfile   # @nearpay-money/* and @nearpay-internal/* from the local registry (.npmrc), the rest from npmjs
pnpm verify                      # typecheck + lint + tests with coverage gate (≥ 90% branches and lines) + build
NP_REGISTRY_PASSWORD=$(cat ../nearpay-deploy/.secrets/registry_password) pnpm release:local   # maintainers: publish to the local registry
```

## Status

Stage 1 (step 1.3): `@nearpay-money/x402` and `@nearpay-money/agent-signer`. Stage 3 (0.2.0, spec 0.3.0): cross-chain
x402 (`near-intents`) in the paywall and the client, hosted-invoice payments, session budgets, and
`@nearpay-money/mcp`. Tests: unit, vector, property (money math, calldata), spec-validating mock integration;
the sandbox E2E runs in `nearpay-testbed`. 0.3.0: packages renamed to the `@nearpay-money` scope (ADR-0025) on
`@nearpay-money/spec` 0.5.0.

## Built with

- Runtime: `@nearpay-money/spec`, `@noble/curves`, `@noble/hashes`, `bs58`, `canonicalize` (RFC 8785), `zod` (peer,
  via `@nearpay-money/spec`), `@modelcontextprotocol/sdk` (`@nearpay-money/mcp`), `hono` (optional peer of
  `@nearpay-money/x402`), `viem` (optional peer of `@nearpay-money/mcp`, EVM origin wallets).
- Development: TypeScript, Vitest, Biome, fast-check, viem (ERC-191 vector check), Express and Hono (adapter tests),
  `@nearpay-internal/intents` (cross-check of the signing formats).
- Licence: Apache-2.0 (`LICENSE`).

Code and documentation are written with AI assistance (Claude) under human direction and review. Built for the NEAR Hackathon (Nov 2026).
