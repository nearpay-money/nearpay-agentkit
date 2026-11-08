#!/usr/bin/env node
/**
 * `nearpay-mcp [--stdio | --http]` — the NearPay MCP server, configured from the environment
 * (see the package README). Logs go to stderr; secrets are never logged.
 */
import { ConfigError, optionsFromEnv } from "./config.js";
import { viemOriginSigner } from "./evm.js";
import { stderrLogger } from "./redact.js";
import { createNearPayMcpContext } from "./server.js";
import { fileOperationStore } from "./store.js";
import { startHttp, startStdio } from "./transports.js";

async function main(argv: readonly string[]): Promise<void> {
  const mode = argv.includes("--http") ? "http" : "stdio";
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write("usage: nearpay-mcp [--stdio | --http]   (configuration: environment, see README)\n");
    return;
  }
  const env = await optionsFromEnv(process.env);
  const { options } = env;
  const log = stderrLogger(options.secrets ?? [], (process.env.NEARPAY_MCP_LOG_LEVEL as "info") ?? "info");
  if (options.payer) {
    if (process.env.NEARPAY_MCP_STATE_DIR) options.payer.store = fileOperationStore(process.env.NEARPAY_MCP_STATE_DIR);
    if (env.evm) {
      options.payer.crossChain = { ...env.crossChain, originSigner: await viemOriginSigner(env.evm) };
    }
  }
  const ctx = createNearPayMcpContext({ ...options, logger: log });
  if (mode === "stdio") {
    await startStdio(ctx);
    return;
  }
  if (!env.http.token) throw new ConfigError("--http needs NEARPAY_MCP_HTTP_TOKEN (or NEARPAY_MCP_HTTP_TOKEN_FILE)");
  await startHttp(ctx, {
    host: env.http.host,
    port: env.http.port,
    token: env.http.token,
    allowedHosts: env.http.allowedHosts,
  });
}

main(process.argv.slice(2)).catch((e) => {
  const msg = e instanceof ConfigError ? `configuration error: ${e.message}` : `fatal: ${(e as Error).message}`;
  stderrLogger()("error", msg);
  process.exit(1);
});
