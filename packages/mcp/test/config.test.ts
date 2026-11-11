import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nearSigner } from "@nearpay-money/agent-signer";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_LIMITS,
  explorerTxUrl,
  fileOperationStore,
  optionsFromEnv,
  parseLimits,
  parseNearKey,
  redact,
  STABLECOINS,
  validateOptions,
} from "../src/index.js";
import { capLimit } from "../src/server.js";
import { NEAR_SEED } from "./support/harness.js";

const signer = nearSigner({ keyPair: NEAR_SEED });
const secretKey = `ed25519:${bs58.encode(NEAR_SEED)}`;

describe("validateOptions", () => {
  it("fails closed", () => {
    expect(() => validateOptions({ livemode: false })).toThrow(ConfigError);
    expect(() => validateOptions({ livemode: false, merchantApiKey: "nope" })).toThrow(/sk_/);
    expect(() => validateOptions({ livemode: true, merchantApiKey: "sk_test_abc" })).toThrow(/test key/);
    expect(() => validateOptions({ livemode: false, payer: { signer, allowedPayTo: [] } })).toThrow(/allow-list/);
    expect(() =>
      validateOptions({
        livemode: false,
        payer: { signer, allowedPayTo: ["m.near"], limits: { perCall: "x", perSession: 1 } },
      }),
    ).toThrow();
    expect(() =>
      validateOptions({ livemode: false, payer: { signer, allowedPayTo: ["m.near"], paymentHosts: ["https://x"] } }),
    ).toThrow(/host/);
    expect(() =>
      validateOptions({ livemode: true, payer: { signer, allowedPayTo: ["m.near"], allowHttp: true } }),
    ).toThrow(/test mode/);
    expect(() =>
      validateOptions({ livemode: true, merchantApiKey: "sk_live_abc", payer: { signer, allowedPayTo: ["m.near"] } }),
    ).not.toThrow();
  });
  it("defaults to small stablecoin limits", () => {
    expect(Object.keys(DEFAULT_LIMITS.perCall as object)).toStrictEqual(Object.values(STABLECOINS));
    expect((DEFAULT_LIMITS.perCall as Record<string, string>)[STABLECOINS["usdc.near"]]).toBe("1000000");
    expect((DEFAULT_LIMITS.perSession as Record<string, string>)[STABLECOINS["usdc.near"]]).toBe("10000000");
  });
});

describe("environment", () => {
  it("reads keys from files, limits, hosts and HTTP settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "np-mcp-"));
    await writeFile(join(dir, "near.json"), JSON.stringify({ account_id: "agent.near", private_key: secretKey }));
    await writeFile(join(dir, "api"), "sk_test_merchant000000000000000000\n");
    await writeFile(join(dir, "token"), "t".repeat(40));
    await writeFile(join(dir, "keys.json"), JSON.stringify({ keys: [{ kid: "s1", public_key: "A".repeat(43) }] }));
    const e = await optionsFromEnv({
      NEARPAY_API_KEY_FILE: join(dir, "api"),
      NEARPAY_MCP_NEAR_PRIVATE_KEY_FILE: join(dir, "near.json"),
      NEARPAY_MCP_ALLOWED_PAY_TO: "merchant.near, shop.near",
      NEARPAY_MCP_LIMITS: JSON.stringify({ perCall: { "nep141:usdc.near": "5" }, perSession: "10" }),
      NEARPAY_MCP_SENTINEL_KEYS_FILE: join(dir, "keys.json"),
      NEARPAY_MCP_PAYMENT_HOSTS: "pay.nearpay.localhost",
      NEARPAY_MCP_HTTP_TOKEN_FILE: join(dir, "token"),
      NEARPAY_MCP_HTTP_PORT: "4000",
      NEARPAY_MCP_CROSS_CHAIN_ORIGINS: "nep141:a.near",
      NEARPAY_MCP_SLIPPAGE_BPS: "80",
      NEARPAY_MCP_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      NEARPAY_MCP_EVM_RPC_URLS: JSON.stringify({ "eip155:8453": "https://base.rpc" }),
    });
    expect(e.options).toMatchObject({
      livemode: false,
      apiBase: "https://api.nearpay.money",
      merchantApiKey: "sk_test_merchant000000000000000000",
    });
    expect(e.options.payer?.signer.signerId).toBe("agent.near");
    expect(e.options.payer?.allowedPayTo).toStrictEqual(["merchant.near", "shop.near"]);
    expect(e.options.payer?.limits).toStrictEqual({ perCall: { "nep141:usdc.near": "5" }, perSession: "10" });
    expect(e.options.payer?.pinnedKeys).toHaveLength(1);
    expect(await e.options.payer?.nonceSaltProvider?.()).toBe("00000000"); // test mode: sandbox salt
    expect(e.http).toMatchObject({
      host: "127.0.0.1",
      port: 4000,
      token: "t".repeat(40),
      allowedHosts: ["127.0.0.1:4000", "localhost:4000"],
    });
    expect(e.crossChain).toMatchObject({ origins: ["nep141:a.near"], slippageBps: 80 });
    expect(e.evm?.rpcUrls).toStrictEqual({ "eip155:8453": "https://base.rpc" });
    expect(e.options.secrets).toEqual(
      expect.arrayContaining([secretKey, "sk_test_merchant000000000000000000", "t".repeat(40)]),
    );
    validateOptions(e.options);
  });
  it("refuses malformed settings", async () => {
    await expect(optionsFromEnv({ NEARPAY_MCP_LIVEMODE: "yes" })).rejects.toThrow(/true or false/);
    await expect(optionsFromEnv({ NEARPAY_MCP_HTTP_PORT: "0" })).rejects.toThrow(/port/);
    await expect(optionsFromEnv({ NEARPAY_MCP_NEAR_PRIVATE_KEY: "ed25519:abc" })).rejects.toThrow(/NEAR key/);
    await expect(optionsFromEnv({ NEARPAY_MCP_NEAR_PRIVATE_KEY: secretKey, NEARPAY_MCP_LIMITS: "{" })).rejects.toThrow(
      /JSON/,
    );
    expect(() => parseLimits('{"perCall":"1"}')).toThrow(/perSession/);
    expect(() => parseLimits('{"perCall":"x","perSession":"1"}')).toThrow(/NEARPAY_MCP_LIMITS/);
    expect(() => parseNearKey("{}")).toThrow(/private_key/);
    expect(parseNearKey(` ${secretKey}\n`)).toStrictEqual({ secretKey });
  });
  it("live mode reads the Verifier salt over RPC and the Intents balance", async () => {
    const e = await optionsFromEnv({
      NEARPAY_MCP_LIVEMODE: "true",
      NEARPAY_MCP_NEAR_PRIVATE_KEY: secretKey,
      NEARPAY_MCP_NEAR_RPC_URLS: "https://rpc.example",
    });
    expect(e.options.livemode).toBe(true);
    expect(e.crossChain?.balance).toBeTypeOf("function");
    expect(e.options.payer?.signer.signerId).toBe(signer.signerId);
  });
});

describe("capLimit", () => {
  it("lowers but never raises", () => {
    expect(capLimit("100", "50")).toBe("50");
    expect(capLimit("100", "500")).toBe("100");
    expect(capLimit({ a: "100", b: 20 }, "50")).toStrictEqual({ a: "50", b: "20" });
    expect(capLimit("100", undefined)).toBe("100");
  });
});

describe("redact", () => {
  it("masks every secret shape and configured literals", () => {
    const text = [
      "sk_live_abcDEF123",
      "rk_test_xyz",
      `cs_01jbz9k3m4n5p6q7r8s9t0v1w2_secret_${"a".repeat(32)}`,
      `in_01jbz9k3m4n5p6q7r8s9t0v1w4_secret_${"b".repeat(32)}`,
      secretKey,
      `k1.1794220320.${"H".repeat(43)}`,
      "Bearer abc.def",
      "https://pay.nearpay.money/c/cs_01jbz9k3m4n5p6q7r8s9t0v1w2#anything",
      "whsec_abc",
      "my-literal-secret",
    ].join(" ");
    const out = redact(text, ["my-literal-secret", "short"]);
    expect(out).not.toMatch(/abcDEF123|aaaaaaaa|bbbbbbbb|HHHHHHHH|abc\.def|#anything|my-literal-secret|whsec_abc/);
    expect(out).not.toContain(secretKey);
    expect(out).toContain("cs_01jbz9k3m4n5p6q7r8s9t0v1w2_secret_[redacted]");
    expect(out).toContain("k1.1794220320.[redacted]");
  });
});

describe("evidence", () => {
  it("links public explorers in live mode only", () => {
    expect(explorerTxUrl("near:mainnet", "9gnJ", true)).toBe("https://nearblocks.io/txns/9gnJ");
    expect(explorerTxUrl("eip155:8453", "0xab", true)).toBe("https://basescan.org/tx/0xab");
    expect(explorerTxUrl("eip155:8453", "0xab", false)).toBeNull();
    expect(explorerTxUrl("eip155:999999", "0xab", true)).toBeNull();
  });
});

describe("fileOperationStore", () => {
  it("persists operations privately and atomically", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "np-ops-")), "ops");
    const s = fileOperationStore(dir);
    expect(await s.get("np1:a")).toBeUndefined();
    const op = { id: "np1:a", state: "deposited", createdAt: 2 } as never;
    await s.put(op);
    await s.put({ id: "np1:b", state: "settled", createdAt: 1 } as never);
    expect((await s.get("np1:a"))?.state).toBe("deposited");
    expect((await s.list()).map((o) => o.id)).toStrictEqual(["np1:b", "np1:a"]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const files = await (await import("node:fs/promises")).readdir(dir);
    for (const f of files) expect((await stat(join(dir, f))).mode & 0o777).toBe(0o600);
    await writeFile(join(dir, `${"0".repeat(64)}.json`), "{broken");
    await expect(s.list()).rejects.toThrow();
  });
});

describe("environment (optional settings)", () => {
  it("passes through every optional setting", async () => {
    const e = await optionsFromEnv({
      NEARPAY_API_BASE: "https://api.nearpay.localhost",
      NEARPAY_MCP_NEAR_PRIVATE_KEY: secretKey,
      NEARPAY_MCP_NEAR_ACCOUNT_ID: "agent.near",
      NEARPAY_MCP_ALLOWED_PAY_TO: "m.near",
      NEARPAY_MCP_PAY_API_BASE: "https://api.nearpay.localhost",
      NEARPAY_MCP_CHECKOUT_WAIT_MS: "1000",
      NEARPAY_MCP_FETCH_WAIT_MS: "2000",
      NEARPAY_MCP_ALLOW_HTTP: "1",
      NEARPAY_MCP_HTTP_HOST: "0.0.0.0",
      NEARPAY_MCP_HTTP_ALLOWED_HOSTS: "mcp.internal:3333",
      NEARPAY_MCP_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      NEARPAY_MCP_EVM_NATIVE_ASSETS: JSON.stringify({ "eip155:1": "nep141:eth.omft.near" }),
    });
    expect(e.options.apiBase).toBe("https://api.nearpay.localhost");
    expect(e.options.payer).toMatchObject({
      payApiBase: "https://api.nearpay.localhost",
      checkoutWaitMs: 1000,
      fetchWaitMs: 2000,
      allowHttp: true,
    });
    expect(e.http).toMatchObject({ host: "0.0.0.0", allowedHosts: ["mcp.internal:3333"] });
    expect(e.evm).toMatchObject({ rpcUrls: {}, nativeAssets: { "eip155:1": "nep141:eth.omft.near" } });
    expect(e.crossChain).toStrictEqual({});
    expect(parseNearKey(JSON.stringify({ secret_key: secretKey }))).toStrictEqual({ secretKey });
  });
});
