# nearpay-agentkit

> Agent payments toolkit: x402 server middleware (Express/Hono/Next) and client, MCP server for agents, NEAR Intents signing helpers.

|                                       |                                                         |
| ------------------------------------- | ------------------------------------------------------- |
| Group                                 | SDKs & tools                                            |
| Kind                                  | library                                                 |
| Ships as                              | npm: @nearpay/x402, @nearpay/mcp, @nearpay/agent-signer |
| Owns                                  | Agent SDKs                                              |
| Depends on (published artifacts only) | spec (public)                                           |
| First built in                        | Stage 1 (step 1.3)                                      |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/sdks-and-tools.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/sdks-and-tools.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/decisions/ADR-0009-agent-payments-x402.md`

## Packages (Stage 1)

| Package                                                    | Version | What                                                                                               |
| ---------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| [`@nearpay/x402`](packages/x402/README.md)                 | 0.1.0   | Paywall middleware (Express, Hono, fetch / Next.js route handlers) and the agent client `withX402` |
| [`@nearpay/agent-signer`](packages/agent-signer/README.md) | 0.1.0   | NEP-413 / ERC-191 signers, `buildTransferPayment`, sentinel-verified `payCheckoutSession`          |
| `@nearpay/mcp`                                             | —       | MCP server for agents (Stage 3)                                                                    |

Both depend only on `@nearpay/spec` (public). Signatures are byte-identical to
`nearpay-spec/test-vectors/intents-payloads.json`; checkout payments are signed only after the
sentinel co-signature verifies with a pinned key.

## Layout

```
nearpay-agentkit/
├── packages/
│   ├── agent-signer/     src: signers, payment (MultiPayload), salt, attestation, checkout, limits, http
│   ├── x402/             src: paywall (core), express, fetch (Next), hono, facilitator, client (withX402)
│   └── mcp/              Stage 3
├── examples/
│   ├── express/          paid `GET /premium`
│   └── agent/            agent paying it with withX402
├── scripts/
│   ├── build-package.mjs tsc → dist (ESM + d.ts)
│   └── release-local.mjs publish to the local registry (loopback Verdaccio only, reproducible tarballs)
└── .github/
```

## Develop

```sh
pnpm install          # @nearpay/* from the local registry (.npmrc), the rest from npmjs
pnpm verify           # typecheck + lint + tests with coverage gate (≥ 90% branches) + build
NP_REGISTRY_PASSWORD=$(cat ../nearpay-deploy/.secrets/registry_password) pnpm release:local
```

## Status

Stage 1 (step 1.3): `@nearpay/x402` and `@nearpay/agent-signer` implemented and tested (unit, vector,
property and mock-backed tests). The x402 E2E against the sandbox runs in `nearpay-testbed` (step 1.4).
`@nearpay/mcp` arrives in Stage 3.

## Built with

Libraries (hackathon rule Q-005): runtime — `@noble/curves`, `@noble/hashes`, `bs58`, `canonicalize`
(RFC 8785), `zod` (peer, via `@nearpay/spec`); development — TypeScript, Vitest, Biome, fast-check,
viem (ERC-191 vector check), Express and Hono (adapter tests). Code and documentation are written with
AI assistance (Claude) under human direction and review.
