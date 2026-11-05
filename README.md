# nearpay-agentkit

> Agent payments toolkit: x402 server middleware (Express/Hono/Next) and client, MCP server for agents, NEAR Intents signing helpers.

| | |
|---|---|
| Group | SDKs & tools |
| Kind | library |
| Ships as | npm: @nearpay/x402, @nearpay/mcp, @nearpay/agent-signer |
| Owns | Agent SDKs |
| Depends on (published artifacts only) | spec (public) |
| First built in | Stage 1 (step 1.3) |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/sdks-and-tools.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/sdks-and-tools.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/decisions/ADR-0009-agent-payments-x402.md`

## Layout

```
nearpay-agentkit/
├── examples/
│   ├── agent/
│   └── express/
├── packages/
│   ├── agent-signer/
│   ├── mcp/
│   └── x402/
├── test/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in **Stage 1 (step 1.3)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
