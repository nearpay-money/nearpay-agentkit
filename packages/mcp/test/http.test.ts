/** Streamable HTTP transport: locked down (token, Host, Origin, method, size) and working with the SDK client. */
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createNearPayMcpContext, startHttp } from "../src/index.js";
import { MERCHANT_KEY } from "./support/harness.js";

const TOKEN = "x".repeat(40);
let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function start() {
  const logs: string[] = [];
  const ctx = createNearPayMcpContext({
    livemode: false,
    merchantApiKey: MERCHANT_KEY,
    apiBase: "https://api.test",
    logger: (_l, msg, f) => logs.push(JSON.stringify({ msg, ...f })),
  });
  const s = await startHttp(ctx, { host: "127.0.0.1", port: 0, token: TOKEN });
  stop = s.close;
  return { ...s, logs };
}

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

describe("startHttp", () => {
  it("serves tools to an authenticated SDK client", async () => {
    const s = await start();
    const client = new Client({ name: "agent", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("nearpay_create_checkout_session");
    await client.close();
  });

  it("refuses unauthenticated, foreign-host, browser-origin, non-POST and oversized requests", async () => {
    const s = await start();
    const post = (headers: Record<string, string>, body = JSON.stringify(init)) =>
      fetch(s.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body,
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ authorization: `Bearer ${TOKEN}` }, "{not json")).status).toBe(400);
    expect((await post({ authorization: `Bearer ${TOKEN}` }, `"${"a".repeat(1_100_000)}"`)).status).toBe(413);
    expect((await fetch(s.url, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect((await fetch(s.url.replace("/mcp", "/other"))).status).toBe(404);
    const port = Number(new URL(s.url).port);
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: { host: "evil.example", authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.on("error", reject);
      r.end("{}");
    });
    expect(status).toBe(403);
    expect(s.logs.join("\n")).not.toContain(TOKEN);
  });

  it("requires a long token", async () => {
    const ctx = createNearPayMcpContext({ livemode: false, merchantApiKey: MERCHANT_KEY });
    await expect(startHttp(ctx, { host: "127.0.0.1", port: 0, token: "short" })).rejects.toThrow(/32 characters/);
  });
});
