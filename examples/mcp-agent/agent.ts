/**
 * An agent using the NearPay MCP server: starts `nearpay-mcp` over stdio, checks its spending limits,
 * pays an x402 resource (or a checkout / invoice URL) and prints the evidence.
 *
 *   NEARPAY_MCP_NEAR_PRIVATE_KEY_FILE=~/.near-credentials/mainnet/agent.near.json \
 *   NEARPAY_MCP_ALLOWED_PAY_TO=merchant.near \
 *   NEARPAY_MCP_SENTINEL_KEYS_FILE=../nearpay-deploy/.secrets/public/sentinel_keys.json \
 *   NEARPAY_MCP_PAYMENT_HOSTS=pay.nearpay.localhost \
 *   node --experimental-strip-types agent.ts https://merchant.example/premium
 *   node --experimental-strip-types agent.ts 'https://pay.nearpay.localhost/i/in_…#in_…_secret_…'
 *
 * In a real agent the model chooses the tools; this script calls them directly to show the shapes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const target = process.argv[2] ?? "http://localhost:3000/premium";
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));

const client = new Client({ name: "example-agent", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.env.NEARPAY_MCP_BIN ?? "nearpay-mcp",
    env: { ...env, NEARPAY_MCP_ALLOW_HTTP: target.startsWith("http://localhost") ? "true" : "false" },
  }),
);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: r.isError === true, data: r.structuredContent as Record<string, unknown> };
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
console.log("limits:", JSON.stringify((await call("nearpay_get_spending")).data.limits, null, 2));

const isHosted = /\/(c|i)\/(cs|in)_/.test(new URL(target).pathname);
const result = isHosted
  ? await call("nearpay_pay_checkout_session", { url: target, wait_seconds: 30 })
  : await call("nearpay_fetch_paid", { url: target, max_amount: "50000" });
console.log(result.error ? "refused:" : "result:", JSON.stringify(result.data, null, 2));

if (!result.error && result.data.status === "pending") {
  const op = (result.data.operation as { id: string }).id;
  console.log("cross-chain settlement pending; resuming", op);
  console.log(
    JSON.stringify(
      (await call("nearpay_resume_paid_fetch", { operation_id: op, max_wait_seconds: 300 })).data,
      null,
      2,
    ),
  );
}
await client.close();
