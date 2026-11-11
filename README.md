# nearpay-agentkit

> Agent payments toolkit: x402 server middleware (Express/Hono/Next) and client, MCP server for agents, NEAR Intents signing helpers.

|                                       |                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------- |
| Group                                 | SDKs & tools                                                              |
| Kind                                  | library                                                                   |
| Ships as                              | npm: @nearpay-money/x402, @nearpay-money/mcp, @nearpay-money/agent-signer |
| Owns                                  | Agent SDKs                                                                |
| Depends on (published artifacts only) | spec (public)                                                             |
| First built in                        | Stage 1 (step 1.3)                                                        |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/sdks-and-tools.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/sdks-and-tools.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/decisions/ADR-0009-agent-payments-x402.md`

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

## Develop

```sh
pnpm install          # @nearpay-money/* from the local registry (.npmrc), the rest from npmjs
pnpm verify           # typecheck + lint + tests with coverage gate (≥ 90% branches) + build
NP_REGISTRY_PASSWORD=$(cat ../nearpay-deploy/.secrets/registry_password) pnpm release:local
```

## Status

Stage 1 (step 1.3): `@nearpay-money/x402` and `@nearpay-money/agent-signer`. Stage 3 (0.2.0, spec 0.3.0): cross-chain
x402 (`near-intents`) in the paywall and the client, hosted-invoice payments, session budgets, and
`@nearpay-money/mcp`. Tests: unit, vector, property (money math, calldata), spec-validating mock integration;
the sandbox E2E runs in `nearpay-testbed`.

## Built with

Libraries (hackathon rule Q-005): runtime — `@noble/curves`, `@noble/hashes`, `bs58`, `canonicalize`
(RFC 8785), `zod` (peer, via `@nearpay-money/spec`), `@modelcontextprotocol/sdk` (`@nearpay-money/mcp`), `viem`
(optional peer of `@nearpay-money/mcp`, EVM origin wallets); development — TypeScript, Vitest, Biome, fast-check,
viem (ERC-191 vector check), Express and Hono (adapter tests). Code and documentation are written with
AI assistance (Claude) under human direction and review.
