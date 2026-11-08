import { describe, expect, it } from "vitest";
import { rpcIntentsBalanceProvider } from "../src/index.js";

const rpc = (result: unknown, status = 200) =>
  (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
    expect(body.params).toMatchObject({ method_name: "mt_balance_of", account_id: "intents.near" });
    expect(args).toStrictEqual({ account_id: "agent.near", token_id: "nep141:usdc.near" });
    return new Response(JSON.stringify({ result: { result: [...new TextEncoder().encode(JSON.stringify(result))] } }), {
      status,
    });
  }) as typeof fetch;

describe("rpcIntentsBalanceProvider", () => {
  it("reads mt_balance_of as bigint", async () => {
    const p = rpcIntentsBalanceProvider({ rpcUrls: ["https://rpc"], fetch: rpc("123456789012345678901234567890") });
    expect(await p("agent.near", "nep141:usdc.near")).toBe(123456789012345678901234567890n);
  });
  it("tries every RPC and reports failures", async () => {
    await expect(
      rpcIntentsBalanceProvider({ rpcUrls: ["https://a", "https://b"], fetch: rpc(12) })(
        "agent.near",
        "nep141:usdc.near",
      ),
    ).rejects.toThrow(/not base units/);
    await expect(
      rpcIntentsBalanceProvider({ rpcUrls: ["https://a"], fetch: rpc("1", 500) })("agent.near", "nep141:usdc.near"),
    ).rejects.toThrow(/HTTP 500/);
    const err = (async () =>
      new Response(JSON.stringify({ error: { name: "HANDLER_ERROR" } }))) as unknown as typeof fetch;
    await expect(rpcIntentsBalanceProvider({ fetch: err })("agent.near", "nep141:usdc.near")).rejects.toThrow(
      /JSON-RPC error/,
    );
    const odd = (async () => new Response(JSON.stringify({ result: {} }))) as unknown as typeof fetch;
    await expect(rpcIntentsBalanceProvider({ fetch: odd })("agent.near", "nep141:usdc.near")).rejects.toThrow(
      /unexpected view result/,
    );
    expect(() => rpcIntentsBalanceProvider({ rpcUrls: [] })).toThrow(RangeError);
  });
});
