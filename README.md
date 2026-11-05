# nearpay-agentkit

> Agent payments toolkit: x402 server middleware (Express/Hono/Next) and client, MCP server for agents, NEAR Intents signing helpers.

| | |
|---|---|
| Group | SDKs & tools |
| Kind | library |
| Ships as | npm: @nearpay/x402, @nearpay/mcp, @nearpay/agent-signer |
| Owns | Agent SDKs |
| Depends on (published artifacts only) | spec (public) |
| Roadmap phase | P2 Refunds, billing, agents |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

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

Scaffold only. Implementation starts in phase **P2 Refunds, billing, agents** (`nearpay-brain/roadmap/roadmap.md`).
