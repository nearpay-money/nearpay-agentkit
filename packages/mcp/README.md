# @nearpay/mcp

NearPay MCP server for AI agents (`nearpay-brain/lld/sdks-and-tools.md` §2): merchant tools on a NearPay
account and payer tools that spend from the agent's own wallet — non-custodially, within limits, only to
allow-listed merchants, with evidence for every payment.

```sh
npx nearpay-mcp            # stdio (default)
npx nearpay-mcp --http     # streamable HTTP on 127.0.0.1:3333/mcp (bearer token required)
```

## Tools

| Tool                              | Needs              | What it does                                                                                                                                                                            |
| --------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nearpay_create_checkout_session` | merchant key       | Creates a checkout session (spec `CheckoutSessionCreate` + `idempotency_key`); returns it with its payer `url`.                                                                         |
| `nearpay_get_payment_intent`      | merchant key       | A payment intent with attempts and their on-chain evidence.                                                                                                                             |
| `nearpay_list_payments`           | merchant key       | Payment intents with the spec's filters (`status`, `created[gte]`, `amount[…]`, `invoice`, `metadata`…) and a next cursor.                                                              |
| `nearpay_pay_checkout_session`    | payer              | Pays a checkout `…/c/cs_…#<client secret>` or hosted invoice `…/i/in_…#<invoice secret>` URL: sentinel attestation verified with pinned keys before signing; waits for the final state. |
| `nearpay_fetch_paid`              | payer              | Fetches a URL and pays its NearPay x402 402: `intents-transfer` from the Intents balance, or cross-chain `near-intents` from an origin wallet when configured.                          |
| `nearpay_resume_paid_fetch`       | payer, cross-chain | Continues a pending cross-chain payment (never pays again).                                                                                                                             |
| `nearpay_get_spending`            | payer              | Limits, spent and remaining per asset, the allow-list, open cross-chain operations.                                                                                                     |

## Safety model

- **Signing** — NEAR Intents NEP-413 with the operator's local key (`ed25519:…` or a NEAR CLI credentials
  file). The key never leaves the process; NearPay only relays what was signed (INV-1).
- **Allow-list** — payer tools exist only with a non-empty `NEARPAY_MCP_ALLOWED_PAY_TO` (merchant NEAR
  Intents accounts). Checkout/invoice URLs must also be on `NEARPAY_MCP_PAYMENT_HOSTS`.
- **Limits** — per call and per session (the server process, shared by all HTTP clients), per asset in
  base units. Default: 1.00 per payment and 10.00 per session of USDC/USDT (NEAR, Base, Arbitrum,
  Ethereum USDC); every other asset is refused until configured. A tool's `max_amount` can only lower the
  per-call limit. Cross-chain limits apply to the quoted deposit (origin asset). Unknown outcomes count
  as spent.
- **Mode** — test mode (default) refuses live sessions/invoices and vice versa; the merchant key must
  match the mode.
- **Secrets** — keys, client and invoice secrets, operation tokens and bearer tokens are redacted from
  logs (stderr) and never returned. The cross-chain store holds operation tokens: directory 0700, files
  0600.
- **HTTP** — bearer token (≥ 32 chars), loopback by default, `Host` allow-list, browser `Origin`s
  refused, 1 MiB bodies, stateless (POST only).
- **Evidence** — every payment returns transaction hashes with explorer links (live mode), the agent
  payment / payment intent / checkout session / invoice ids the merchant sees, and the attested merchant
  name and destination fingerprint.

## Configuration (environment; secrets also as `<NAME>_FILE`)

| Variable                                                                                                     | Meaning                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `NEARPAY_MCP_LIVEMODE`                                                                                       | `true` for live mode (real funds); default `false`.                                              |
| `NEARPAY_API_KEY`, `NEARPAY_API_BASE`                                                                        | Merchant key (`sk_…`/`rk_…`) and API origin (default `https://api.nearpay.money`).               |
| `NEARPAY_MCP_NEAR_PRIVATE_KEY`, `NEARPAY_MCP_NEAR_ACCOUNT_ID`                                                | Payer key (`ed25519:…` or NEAR CLI JSON) and account (default: from the file / implicit).        |
| `NEARPAY_MCP_ALLOWED_PAY_TO`                                                                                 | Comma-separated merchant Intents accounts (required for payer tools).                            |
| `NEARPAY_MCP_LIMITS`                                                                                         | `{"perCall": {...}, "perSession": {...}}` (base units per asset id, or one value).               |
| `NEARPAY_MCP_SENTINEL_KEYS_FILE`                                                                             | Pinned sentinel keys (`sentinel_keys.json`); without them checkout/invoice payments are refused. |
| `NEARPAY_MCP_PAYMENT_HOSTS`, `NEARPAY_MCP_PAY_API_BASE`                                                      | Allowed pay hosts (default `pay.nearpay.money`); payer API base (default `<origin>/api`).        |
| `NEARPAY_MCP_NEAR_RPC_URLS`                                                                                  | NEAR RPC for the Verifier salt and Intents balance (test mode without it: sandbox salt).         |
| `NEARPAY_MCP_STATE_DIR`                                                                                      | Durable cross-chain operation store.                                                             |
| `NEARPAY_MCP_EVM_PRIVATE_KEY`, `NEARPAY_MCP_EVM_RPC_URLS`, `NEARPAY_MCP_EVM_NATIVE_ASSETS`                   | Cross-chain origin wallet (needs `viem`): key, `{"eip155:8453": "<rpc>"}`, native coins.         |
| `NEARPAY_MCP_CROSS_CHAIN_ORIGINS`, `NEARPAY_MCP_SLIPPAGE_BPS`                                                | Allowed origin assets in preference order; requested slippage.                                   |
| `NEARPAY_MCP_CHECKOUT_WAIT_MS`, `NEARPAY_MCP_FETCH_WAIT_MS`, `NEARPAY_MCP_ALLOW_HTTP`                        | Waits (30 s / 120 s); `http://` resources (test mode only).                                      |
| `NEARPAY_MCP_HTTP_TOKEN`, `NEARPAY_MCP_HTTP_HOST`, `NEARPAY_MCP_HTTP_PORT`, `NEARPAY_MCP_HTTP_ALLOWED_HOSTS` | HTTP transport.                                                                                  |

Claude Desktop / Claude Code:

```json
{
  "mcpServers": {
    "nearpay": {
      "command": "npx",
      "args": ["-y", "@nearpay/mcp"],
      "env": {
        "NEARPAY_MCP_NEAR_PRIVATE_KEY_FILE": "/home/me/.near-credentials/mainnet/agent.near.json",
        "NEARPAY_MCP_ALLOWED_PAY_TO": "merchant.near",
        "NEARPAY_MCP_SENTINEL_KEYS_FILE": "/home/me/nearpay/sentinel_keys.json"
      }
    }
  }
}
```

Embedding: `createNearPayMcpServer(options)` returns an SDK `McpServer`; `startStdio` / `startHttp` run
it. Example agent: `examples/mcp-agent/agent.ts`.

## Tests

An SDK client over the in-memory transport drives every tool against a spec-validating mock (merchant
routes: credentials, version, idempotency keys, strict params/query/body, response schemas) and the
agent-signer / x402 fakes (checkout, invoice, sentinel, facilitator incl. near-intents); the HTTP
lockdown runs over real sockets; the viem origin signer signs against a fake JSON-RPC. License
Apache-2.0.
